import http from 'node:http';
import https from 'node:https';

import { AdapterEventError } from './events.mjs';

const UNSUPPORTED_SETTINGS = [
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'max_completion_tokens',
  'max_output_tokens',
  'max_tokens',
  'n',
  'parallel_tool_calls',
  'presence_penalty',
  'reasoning_effort',
  'response_format',
  'seed',
  'stop',
  'temperature',
  'tool_choice',
  'top_logprobs',
  'top_p',
];

export function createGeminiAdapter({ providerIdleTimeoutMs }) {
  return Object.freeze({
    kind: 'gemini',
    forward(context) {
      return forwardGemini({ ...context, providerIdleTimeoutMs });
    },
  });
}

function forwardGemini({ res, payload, route, onEvent, providerIdleTimeoutMs, signal }) {
  const { provider, model } = route;
  let outbound;
  let target;
  try {
    outbound = toGeminiRequest(payload);
    target = geminiTarget(route);
  } catch (error) {
    const safe = error instanceof AdapterEventError
      ? error
      : invalidGeminiRequest(error.message);
    onEvent({ type: 'error', provider: provider.id, error: safe.toEvent().error });
    respondJson(res, safe.status || 400, { error: safe.toEvent().error });
    return;
  }

  const lifecycle = createLifecycle({ res, onEvent, provider: provider.id, signal });
  const body = Buffer.from(JSON.stringify(outbound), 'utf8');
  const headers = {
    accept: 'text/event-stream',
    ...(provider.headers || {}),
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    host: target.host,
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  onEvent({ type: 'route', provider: provider.id, model: model.model, adapter: 'gemini' });
  const client = target.protocol === 'https:' ? https : http;
  const providerReq = client.request({
    signal,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers,
  }, (providerRes) => {
    lifecycle.setSource(providerRes);
    if (lifecycle.terminal || signal?.aborted || res.destroyed) {
      providerRes.resume();
      return;
    }
    if ((providerRes.statusCode || 500) >= 300) {
      providerRes.resume();
      lifecycle.fail(geminiHttpError(providerRes.statusCode));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    writeChunk(res, { role: 'assistant' });
    translateSse(providerRes, res, (event) => onEvent({ ...event, provider: provider.id }), lifecycle);
  });
  lifecycle.setRequest(providerReq);

  let timedOut = false;
  providerReq.setTimeout(providerIdleTimeoutMs, () => {
    if (lifecycle.terminal) return;
    timedOut = true;
    providerReq.destroy(new Error('provider idle timeout'));
  });
  providerReq.on('error', (error) => {
    if (lifecycle.terminal || signal?.aborted || res.destroyed) return;
    const category = timedOut ? 'timeout' : error.code === 'ABORT_ERR' ? 'cancelled' : 'upstream';
    const safe = new AdapterEventError(
      timedOut ? `Provider produced no data for ${Math.round(providerIdleTimeoutMs / 1000)} seconds.`
        : category === 'cancelled' ? 'Request cancelled.' : `${provider.name} is unreachable.`,
      { category, retryable: category === 'timeout' || category === 'upstream', cause: error },
    );
    if (category === 'cancelled') lifecycle.cancel();
    else lifecycle.fail(safe);
  });
  providerReq.end(body);
}

function geminiTarget(route) {
  if (route.endpointFamily !== 'generate-content') {
    throw invalidGeminiRequest('Gemini routes require the generate-content endpoint family.');
  }
  if (route.authPolicy.type !== 'bearer') {
    throw invalidGeminiRequest('Gemini SDC routes require bearer authentication.');
  }
  const base = route.provider.baseUrl.replace(/\/$/, '');
  return new URL(`${base}/models/${encodeURIComponent(route.wireModel)}:streamGenerateContent?alt=sse`);
}

function toGeminiRequest(payload) {
  if (!Array.isArray(payload.messages) || payload.messages.length !== 1) {
    throw invalidGeminiRequest('Gemini text requests require exactly one user message.');
  }
  const [message] = payload.messages;
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.role !== 'user') {
    throw invalidGeminiRequest('Gemini text requests require exactly one user message.');
  }
  if (typeof message.content !== 'string' || !message.content) {
    throw invalidGeminiRequest('Gemini user content must be a non-empty string.');
  }
  if (payload.tools !== undefined || payload.functions !== undefined) {
    throw invalidGeminiRequest('Gemini text requests do not support tools.');
  }
  const setting = UNSUPPORTED_SETTINGS.find((name) => payload[name] !== undefined);
  if (setting) {
    throw invalidGeminiRequest(`Gemini text requests do not support the "${setting}" setting.`);
  }
  return {
    contents: [{ role: 'user', parts: [{ text: message.content }] }],
  };
}

function translateSse(source, res, onEvent, lifecycle) {
  let buffer = '';
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    if (lifecycle.terminal) return;
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop();
    for (const frame of frames) {
      if (lifecycle.terminal) break;
      try {
        const value = parseGeminiFrame(frame);
        handleGeminiResponse(value, res, onEvent, lifecycle);
      } catch (error) {
        lifecycle.fail(new AdapterEventError(error.message, {
          category: 'malformed-response',
          retryable: false,
        }));
      }
    }
  });
  source.on('end', () => {
    if (lifecycle.terminal) return;
    lifecycle.fail(new AdapterEventError(
      buffer.trim()
        ? 'The Gemini provider stream ended with an incomplete frame.'
        : 'The Gemini provider stream ended before STOP.',
      { category: 'truncated', retryable: true },
    ));
  });
  source.on('error', () => {
    if (!lifecycle.terminal) lifecycle.fail(new AdapterEventError(
      'The Gemini provider response stream was interrupted.',
      { category: 'truncated', retryable: true },
    ));
  });
  source.on('aborted', () => {
    if (!lifecycle.terminal) lifecycle.fail(new AdapterEventError(
      'The Gemini provider response stream was aborted by the remote end.',
      { category: 'truncated', retryable: true },
    ));
  });
}

function parseGeminiFrame(frame) {
  const dataLines = frame.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) throw new Error('The Gemini provider stream contained a malformed SSE frame.');
  let value;
  try {
    value = JSON.parse(dataLines.join('\n').trim());
  } catch {
    throw new Error('The Gemini provider stream contained invalid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Gemini provider stream contained an invalid response.');
  }
  return value;
}

function handleGeminiResponse(value, res, onEvent, lifecycle) {
  if (!Array.isArray(value.candidates) || value.candidates.length !== 1) {
    throw new Error('The Gemini provider stream contained an invalid candidate response.');
  }
  const [candidate] = value.candidates;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('The Gemini provider stream contained an invalid candidate response.');
  }
  const parts = candidate.content?.parts;
  if (parts !== undefined) {
    if (!Array.isArray(parts)) {
      throw new Error('The Gemini provider stream contained invalid content parts.');
    }
    for (const part of parts) {
      if (!part || typeof part !== 'object' || Array.isArray(part) || typeof part.text !== 'string') {
        throw new Error('The Gemini provider stream contained a non-text content part.');
      }
      if (!part.text) continue;
      onEvent({ type: 'text', text: part.text });
      writeChunk(res, { content: part.text });
    }
  }
  if (candidate.finishReason !== undefined) {
    if (candidate.finishReason !== 'STOP') {
      throw new Error('The Gemini provider stream contained an unsupported finish reason.');
    }
    onEvent({ type: 'finish', reason: 'stop' });
    writeChunk(res, {}, 'stop');
    lifecycle.complete();
  }
}

function createLifecycle({ res, onEvent, provider, signal }) {
  let terminal = false;
  let request;
  let source;
  const removeListeners = () => {
    signal?.removeEventListener('abort', cancel);
    res.removeListener('close', onClose);
  };
  const release = () => {
    removeListeners();
    if (source && !source.destroyed) source.destroy();
    if (request && !request.destroyed) request.destroy();
  };
  const cancel = () => {
    if (terminal) return;
    terminal = true;
    release();
  };
  const fail = (error) => {
    if (terminal || signal?.aborted || res.destroyed) return;
    terminal = true;
    const payload = error.toEvent().error;
    onEvent({ type: 'error', provider, error: payload });
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ error: payload })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    } else {
      respondJson(res, error.status || 502, { error: payload });
    }
    release();
  };
  const complete = () => {
    if (terminal) return;
    terminal = true;
    removeListeners();
    if (!res.writableEnded && !res.destroyed) res.end('data: [DONE]\n\n');
    if (source && !source.destroyed) source.destroy();
  };
  const onClose = () => {
    if (!res.writableEnded) cancel();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  res.once('close', onClose);
  return {
    get terminal() { return terminal; },
    setRequest(value) {
      request = value;
      if (terminal && !request.destroyed) request.destroy();
    },
    setSource(value) {
      source = value;
      if (terminal && !source.destroyed) source.destroy();
    },
    cancel,
    fail,
    complete,
  };
}

function geminiHttpError(status = 502) {
  const definitions = {
    400: ['invalid-request', false, 'The Gemini provider rejected the request.'],
    401: ['authentication', false, 'The Gemini provider rejected its credentials.'],
    403: ['authorization', false, 'The Gemini provider denied access.'],
    404: ['not-found', false, 'The Gemini provider endpoint was not found.'],
    408: ['timeout', true, 'The Gemini provider timed out.'],
    413: ['invalid-request', false, 'The Gemini provider rejected the request as too large.'],
    429: ['rate-limit', true, 'The Gemini provider rate limit was exceeded.'],
  };
  const [category, retryable, message] = definitions[status]
    || (status >= 500
      ? ['upstream', true, 'The Gemini provider failed to complete the request.']
      : ['upstream', false, 'The Gemini provider rejected the request.']);
  return new AdapterEventError(message, { category, status, retryable });
}

function invalidGeminiRequest(message) {
  return new AdapterEventError(message, {
    category: 'invalid-request',
    status: 400,
    retryable: false,
  });
}

function writeChunk(res, delta, finishReason = null) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
