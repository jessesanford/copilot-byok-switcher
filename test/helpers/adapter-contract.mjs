import assert from 'node:assert/strict';
import http from 'node:http';

import { buildCatalog } from '../../src/catalog.mjs';
import { createUpstreamResolver } from '../../src/upstream.mjs';

export const CONTRACT_CASES = Object.freeze(['tracer', 'timeout', 'truncation', 'cancellation']);

const SECRET = 'contract-secret';
const OBSERVATION_MS = 100;
let moduleNonce = 0;

export async function runAdapterContract(options) {
  for (const name of CONTRACT_CASES) await runContractCase(name, options);
}

export async function runContractCase(name, options = {}) {
  assert.ok(CONTRACT_CASES.includes(name), `Unknown adapter contract case: ${name}`);
  return ({ tracer, timeout, truncation, cancellation })[name](options);
}

async function tracer(options = {}) {
  const frames = ['data: {"id":"chat-1","choices":[{"delta":{"content":"Checking "}}]}\n\n', 'data: {"id":"chat-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\n', 'data: {"id":"chat-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Berlin\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n', 'data: [DONE]\n\n'];
  const received = {};
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.path = req.url;
      received.authorization = req.headers.authorization;
      received.body = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  const request = { model: 'byok-contract-trace-model', stream: true, messages: [{ role: 'user', content: 'Weather?' }], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }] };
  const expectedBody = Buffer.from(JSON.stringify({ ...request, model: 'trace-model' }), 'utf8');
  const { response, cleanup } = await start({ provider, options, request });
  try {
    assert.equal(response.status, 200, 'adapter contract tracer: expected a 200 response');
    assert.equal(await response.text(), frames.join(''), 'adapter contract tracer: expected exact SSE response bytes');
    assert.equal(received.path, '/v1/chat/completions', 'adapter contract tracer: expected chat-completions path');
    assert.equal(received.authorization, `Bearer ${SECRET}`, 'adapter contract tracer: expected exact provider Authorization');
    assert.deepEqual(received.body, expectedBody, 'adapter contract tracer: expected exact routed request bytes');
  } finally {
    await cleanup();
  }
}

async function timeout(options = {}) {
  const events = [];
  const timeoutMs = options.timeoutMs ?? 75;
  const provider = http.createServer(() => {});
  const request = { model: 'byok-contract-timeout-model', messages: [] };
  const { response, cleanup } = await start({ provider, options, timeoutMs, events, request });
  try {
    const body = await response.text();
    assert.equal(response.status, 502, 'adapter contract timeout: expected deterministic 502 response');
    assert.deepEqual(JSON.parse(body), { error: { category: 'timeout', message: `Provider produced no data for ${Math.round(timeoutMs / 1000)} seconds.`, retryable: true } }, 'adapter contract timeout: expected deterministic timeout payload');
    assert.ok(!body.includes(SECRET), 'adapter contract timeout: response must not serialize the provider secret');
    assertTerminalTimeout(events);
    assert.ok(!JSON.stringify(events).includes(SECRET), 'adapter contract timeout: events must not serialize the provider secret');
    await observeNoLaterTerminalEvent(events, 'timeout');
  } finally {
    await cleanup();
  }
}

async function truncation(options = {}) {
  const events = [];
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial');
    setTimeout(() => res.socket.destroy(), 20);
  });
  const { response, cleanup } = await start({ provider, options, events, request: { model: 'byok-contract-truncated-model', messages: [] } });
  try {
    assert.match(await response.text(), /partial$/, 'adapter contract truncation: expected partial stream');
    const errors = events.filter((event) => event.type === 'error');
    assert.equal(errors.length, 1, 'adapter contract truncation: expected exactly one terminal event');
    assert.equal(errors[0].error.category, 'truncated', 'adapter contract truncation: expected truncated event');
  } finally {
    await cleanup();
  }
}

async function cancellation(options = {}) {
  let aborts = 0;
  let providerStarted;
  const providerReady = new Promise((resolve) => { providerStarted = resolve; });
  const provider = http.createServer((req, res) => {
    providerStarted();
    req.once('aborted', () => { aborts += 1; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\\n\\n');
  });
  const events = [];
  const request = { model: 'byok-contract-cancel-model', messages: [] };
  const { router, cleanup } = await start({ provider, options, events, request, returnRouter: true });
  const client = http.request({ hostname: '127.0.0.1', port: router.address().port, path: '/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } });
  client.on('error', () => {});
  client.end(JSON.stringify(request));
  try {
    try {
      await settleWithin(providerReady, 300, 'adapter contract cancellation: provider did not start');
    } catch {
      assert.fail('adapter contract cancellation: provider did not start');
    }
    await delay(20);
    client.destroy();
    await delay(OBSERVATION_MS);
    assert.equal(aborts, 1, 'adapter contract cancellation: expected exactly one provider abort');
    assert.equal(events.filter((event) => event.type === 'error').length, 0, 'adapter contract cancellation: expected no terminal error');
  } finally {
    client.destroy();
    await cleanup();
  }
}

async function start({ provider, options, request, events = [], timeoutMs = 300, returnRouter = false }) {
  const priorTimeout = process.env.COPILOT_BYOK_PROVIDER_TIMEOUT_MS;
  process.env.COPILOT_BYOK_PROVIDER_TIMEOUT_MS = String(timeoutMs);
  let createRouter;
  try {
    ({ createRouter } = await import(`../../src/router.mjs?adapter-contract-${moduleNonce++}`));
  } finally {
    if (priorTimeout === undefined) delete process.env.COPILOT_BYOK_PROVIDER_TIMEOUT_MS;
    else process.env.COPILOT_BYOK_PROVIDER_TIMEOUT_MS = priorTimeout;
  }
  await listen(provider);
  const model = request.model.includes('trace') ? 'trace-model' : request.model.replace('byok-contract-', '');
  const catalog = buildCatalog([{ id: 'contract', name: 'Contract', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: SECRET, adapterKind: options.adapterKind ?? 'openai', models: [{ model }] }]);
  const adapter = options.adapter ?? options.adapterFactory?.({ timeoutMs });
  const router = createRouter({ catalog, adapters: adapter ? { resolve: () => adapter } : undefined, onEvent: (event) => events.push(event), upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }) });
  await listen(router);
  const cleanup = async () => {
    await router.shutdown();
    provider.closeAllConnections();
    await close(provider);
  };
  if (returnRouter) return { router, cleanup };
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    return { response, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function assertTerminalTimeout(events) {
  const terminal = events.filter((event) => event.type === 'error');
  assert.equal(terminal.length, 1, 'adapter contract timeout: expected exactly one terminal timeout event');
  assert.equal(terminal[0].error.category, 'timeout', 'adapter contract timeout: expected timeout event');
}

async function observeNoLaterTerminalEvent(events, name) {
  const count = events.filter((event) => event.type === 'error').length;
  await delay(OBSERVATION_MS);
  assert.equal(events.filter((event) => event.type === 'error').length, count, `adapter contract ${name}: must not emit a later terminal event`);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settleWithin(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}
