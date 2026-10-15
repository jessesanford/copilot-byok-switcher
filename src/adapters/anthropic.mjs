import http from 'node:http';
import https from 'node:https';

import { AdapterEventError } from './events.mjs';

const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicAdapter({ providerIdleTimeoutMs }) {
  return Object.freeze({
    kind: 'anthropic',
    forward(context) {
      return forwardAnthropic({ ...context, providerIdleTimeoutMs });
    },
  });
}

function forwardAnthropic({ res, payload, route, onEvent, providerIdleTimeoutMs, signal }) {
  const { provider, model } = route;
  const target = new URL(`${provider.baseUrl.replace(/\/$/, '')}/messages`);
  const client = target.protocol === 'https:' ? https : http;
  let outbound;
  try {
    outbound = toAnthropicRequest(payload, route);
  } catch (error) {
    const safe = new AdapterEventError(error.message, { category: 'invalid-request', status: 400 });
    onEvent({ type: 'error', provider: provider.id, error: safe.toEvent().error });
    respondJson(res, 400, { error: safe.toEvent().error });
    return;
  }
  const body = Buffer.from(JSON.stringify(outbound), 'utf8');
  const headers = {
    accept: 'text/event-stream',
    ...(provider.headers || {}),
    'anthropic-version': provider.anthropicVersion || ANTHROPIC_VERSION,
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    host: target.host,
  };
  if (provider.apiKey && route.authPolicy.type !== 'none') {
    headers[route.authPolicy.header || 'x-api-key'] = provider.apiKey;
  }

  onEvent({ type: 'route', provider: provider.id, model: model.model, adapter: 'anthropic' });
  const providerReq = client.request({ signal,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers,
  }, (providerRes) => {
    if (signal?.aborted || res.destroyed) {
      providerRes.resume();
      return;
    }
    if ((providerRes.statusCode || 500) >= 300) {
      res.writeHead(providerRes.statusCode, providerRes.headers);
      providerRes.pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    translateSse(providerRes, res, (event) => onEvent({ ...event, provider: provider.id }));
  });

  let timedOut = false;
  providerReq.setTimeout(providerIdleTimeoutMs, () => {
    timedOut = true;
    providerReq.destroy(new Error('provider idle timeout'));
  });
  providerReq.on('error', (error) => {
    if (signal?.aborted || res.destroyed) return;
    const category = timedOut ? 'timeout' : error.code === 'ABORT_ERR' ? 'cancelled' : 'upstream';
    const safe = new AdapterEventError(
      timedOut ? `Provider produced no data for ${Math.round(providerIdleTimeoutMs / 1000)} seconds.`
        : category === 'cancelled' ? 'Request cancelled.' : `${provider.name} is unreachable.`,
      { category, retryable: category === 'timeout' || category === 'upstream', cause: error },
    );
    onEvent({ type: 'error', provider: provider.id, error: safe.toEvent().error });
    respondJson(res, safe.status || 502, { error: safe.toEvent().error });
  });
  res.on('close', () => {
    if (!res.writableEnded) providerReq.destroy();
  });
  providerReq.end(body);
}

function toAnthropicRequest(payload, route) {
  const system = [];
  const messages = [];
  for (const message of payload.messages || []) {
    const content = textContent(message.content);
    if (message.role === 'system') system.push(content);
    else if (message.role === 'user' || message.role === 'assistant') messages.push({ role: message.role, content });
    else throw new TypeError(`Anthropic text streaming does not support the "${message.role}" message role.`);
  }
  if (!messages.length) throw new TypeError('Anthropic requests require at least one user or assistant message.');
  return {
    model: route.wireModel,
    ...(system.length ? { system: system.join('\n') } : {}),
    messages,
    max_tokens: payload.max_tokens ?? route.model.maxOutputTokens ?? 4096,
    stream: true,
  };
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every((part) => part?.type === 'text' && typeof part.text === 'string')) {
    return content.map((part) => part.text).join('');
  }
  throw new TypeError('Anthropic text streaming supports only text message content.');
}

function translateSse(source, res, onEvent) {
  let buffer = '';
  let finished = false;
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    if (reason && !res.destroyed) {
      const error = new AdapterEventError(reason, { category: 'truncated', retryable: true });
      onEvent({ type: 'error', error: error.toEvent().error });
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleFrame(frame, res, onEvent, () => { finished = true; });
    }
  });
  source.on('end', () => finish(finished ? undefined : 'stream ended before message_stop'));
  source.on('error', (error) => finish(`stream interrupted: ${error.message}`));
  source.on('aborted', () => finish('stream aborted by the remote end'));
}

function handleFrame(frame, res, onEvent, markFinished) {
  const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
  const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  if (!data) return;
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    return;
  }
  if (event === 'message_start') {
    writeChunk(res, value.message?.id, value.message?.model, { role: 'assistant' });
  } else if (event === 'content_block_delta' && value.delta?.type === 'text_delta') {
    onEvent({ type: 'text', text: value.delta.text });
    writeChunk(res, undefined, undefined, { content: value.delta.text });
  } else if (event === 'message_delta') {
    writeChunk(res, undefined, undefined, {}, mapStopReason(value.delta?.stop_reason));
  } else if (event === 'error') {
    const error = new AdapterEventError(value.error?.message || 'Anthropic provider error.', { category: 'upstream', retryable: false });
    onEvent({ type: 'error', error: error.toEvent().error });
  } else if (event === 'message_stop') {
    res.write('data: [DONE]\n\n');
    markFinished();
    res.end();
  }
}

function writeChunk(res, id, model, delta, finishReason = null) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify({
    ...(id ? { id } : {}),
    object: 'chat.completion.chunk',
    ...(model ? { model } : {}),
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}

function mapStopReason(reason) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return reason ? 'stop' : null;
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
