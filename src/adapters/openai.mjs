import http from 'node:http';
import https from 'node:https';

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

function forwardOpenAI({ req, res, payload, route, onEvent, providerIdleTimeoutMs }) {
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

  const providerReq = client.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers,
  }, (providerRes) => {
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
      return forwardOpenAI({ req, res, payload, route, onEvent, providerIdleTimeoutMs });
    }

    res.writeHead(providerRes.statusCode, providerRes.headers);
    providerRes.pipe(res);
    endOnBrokenSource(providerRes, res, (message) => {
      onEvent({ type: 'error', provider: provider.id, message });
    });
  });

  providerReq.setTimeout(providerIdleTimeoutMs, () => {
    providerReq.destroy(new Error(`no data for ${Math.round(providerIdleTimeoutMs / 1000)}s`));
  });
  providerReq.on('error', (error) => {
    onEvent({ type: 'error', provider: provider.id, message: error.message });
    respondJson(res, 502, { error: { message: `${provider.name} is unreachable: ${error.message}` } });
  });
  res.on('close', () => {
    if (!res.writableEnded) providerReq.destroy();
  });
  providerReq.end(body);
}

function endOnBrokenSource(source, res, report) {
  const finish = (reason) => {
    report(reason);
    if (!res.writableEnded) res.end();
  };
  source.on('error', (error) => finish(`stream interrupted: ${error.message}`));
  source.on('aborted', () => finish('stream aborted by the remote end'));
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
