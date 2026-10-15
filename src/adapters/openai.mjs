import http from 'node:http';
import https from 'node:https';

import { AdapterEventError } from './events.mjs';

const EFFORT_LADDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
const rejectedEfforts = new Map();

function nextEffortDown(effort) {
  const index = EFFORT_LADDER.indexOf(effort);
  return index === -1 || index === EFFORT_LADDER.length - 1 ? null : EFFORT_LADDER[index + 1];
}

export function createOpenAIAdapter({ providerIdleTimeoutMs }) {
  return Object.freeze({
    kind: 'openai',
    forward(context) {
      return forwardOpenAI({ ...context, providerIdleTimeoutMs });
    },
  });
}

function applyAuthPolicy({ target, headers, apiKey, policy }) {
  if (!apiKey || policy.type === 'none') return;
  if (policy.type === 'bearer') {
    headers.authorization = `Bearer ${apiKey}`;
  } else if (policy.type === 'x-api-key') {
    headers[policy.header || 'x-api-key'] = apiKey;
  } else if (policy.type === 'api-key') {
    target.searchParams.set(policy.query || 'key', apiKey);
  }
}

function forwardOpenAI({ req, res, payload, route, onEvent, providerIdleTimeoutMs, signal }) {
  const { provider, model } = route;
  const responses = route.endpointFamily === 'responses';
  const target = new URL(`${provider.baseUrl.replace(/\/$/, '')}/${responses ? 'responses' : 'chat/completions'}`);
  const client = target.protocol === 'https:' ? https : http;
  const outbound = responses ? toResponsesPayload(payload, route.wireModel) : { ...payload, model: route.wireModel };

  const configured = model.reasoningEffort || provider.reasoningEffort;
  if (!responses && configured && outbound.reasoning_effort === undefined) {
    const rejected = rejectedEfforts.get(`${provider.id}:${model.model}`) || new Set();
    let effort = configured;
    while (effort && rejected.has(effort)) effort = nextEffortDown(effort);
    if (effort) outbound.reasoning_effort = effort;
  }
  const body = Buffer.from(JSON.stringify(outbound), 'utf8');
  const headers = {
    accept: req.headers.accept || 'application/json',
    ...(provider.headers || {}),
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    host: target.host,
  };
  applyAuthPolicy({ target, headers, apiKey: provider.apiKey, policy: route.authPolicy });

  onEvent({ type: 'route', provider: provider.id, model: model.model, adapter: 'openai' });

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
      if (!responses && providerRes.statusCode === 400 && outbound.reasoning_effort) {
      const key = `${provider.id}:${model.model}`;
      const rejected = rejectedEfforts.get(key) || new Set();
      rejected.add(outbound.reasoning_effort);
      rejectedEfforts.set(key, rejected);

      const fallback = nextEffortDown(outbound.reasoning_effort);
      onEvent({
        type: 'notice',
        provider: provider.id,
        message: `${model.model} rejected reasoning effort "${outbound.reasoning_effort}"`
          + (fallback ? `, retrying with "${fallback}"` : ', retrying without it'),
      });
      providerRes.resume();
      if (!signal?.aborted && !res.destroyed) {
        return forwardOpenAI({ req, res, payload, route, onEvent, providerIdleTimeoutMs, signal });
      }
      return;
    }

    if (responses && providerRes.statusCode >= 200 && providerRes.statusCode < 300
      && String(providerRes.headers['content-type'] || '').includes('text/event-stream')) {
      relayResponsesStream(providerRes, res, route.wireModel);
    } else {
      res.writeHead(providerRes.statusCode, providerRes.headers);
      providerRes.pipe(res);
    }
    endOnBrokenSource(providerRes, res, (message) => {
      if (signal?.aborted || res.destroyed) return;
      const truncated = new AdapterEventError(message, { category: 'truncated', retryable: true });
      onEvent({ type: 'error', provider: provider.id, message, error: truncated.toEvent().error });
    });
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

function relayResponsesStream(source, res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let buffer = '';
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    buffer += chunk;
    const frames = buffer.split(/\n\n/);
    buffer = frames.pop();
    for (const frame of frames) {
      const line = frame.split('\n').find((entry) => entry.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        res.write('data: [DONE]\n\n');
        continue;
      }
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.type === 'response.output_text.delta') {
        res.write(`data: ${JSON.stringify({ id: event.response?.id || 'response', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: event.delta || '' }, finish_reason: null }] })}\n\n`);
      }
    }
  });
}

function toResponsesPayload(payload, wireModel) {
  const outbound = { ...payload, model: wireModel };
  if (outbound.messages && !outbound.input) {
    outbound.input = outbound.messages;
    delete outbound.messages;
  }
  if (Array.isArray(outbound.input)) outbound.input = toResponsesInput(outbound.input);
  delete outbound.reasoning_effort;
  delete outbound.temperature;
  delete outbound.top_p;
  delete outbound.stream_options;
  if (Array.isArray(outbound.tools)) {
    outbound.tools = outbound.tools.map((tool) => {
      if (tool?.type !== 'function' || !tool.function) return tool;
      return { type: 'function', ...tool.function };
    });
  }
  return outbound;
}

function toResponsesInput(messages) {
  return messages.map((message) => {
    if (message?.role === 'tool') {
      return { type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' };
    }
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
    const content = message.content == null ? [] : [{ type: 'output_text', text: message.content }];
    const items = [...content];
    for (const call of message.tool_calls) {
      const fn = call?.function;
      if (!fn?.name) continue;
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: fn.name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      });
    }
    return { role: 'assistant', content: items };
  });
}

function endOnBrokenSource(source, res, report) {
  let finished = false;
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    report(reason);
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  source.on('error', (error) => finish(`stream interrupted: ${error.message}`));
  source.on('aborted', () => finish('stream aborted by the remote end'));
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
