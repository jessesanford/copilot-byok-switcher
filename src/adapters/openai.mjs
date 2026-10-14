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
  const target = new URL(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`);
  const client = target.protocol === 'https:' ? https : http;
  const outbound = { ...payload, model: route.wireModel };

  const configured = model.reasoningEffort || provider.reasoningEffort;
  if (configured && outbound.reasoning_effort === undefined) {
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
    if (providerRes.statusCode === 400 && outbound.reasoning_effort) {
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

    res.writeHead(providerRes.statusCode, providerRes.headers);
    providerRes.pipe(res);
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
