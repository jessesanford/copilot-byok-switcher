import assert from 'node:assert/strict';
import http from 'node:http';

import { buildCatalog } from '../../src/catalog.mjs';
import { createUpstreamResolver } from '../../src/upstream.mjs';

export const CONTRACT_CASES = Object.freeze([
  'tracer',
  'provider-error',
  'malformed',
  'timeout',
  'truncation',
  'cancellation',
]);
export const OPENAI_CONTRACT_CASES = Object.freeze(['tracer', 'timeout', 'truncation', 'cancellation']);
export const ANTHROPIC_CONTRACT_CASES = CONTRACT_CASES;

const SECRET = 'contract-secret';
const OBSERVATION_MS = 100;
let moduleNonce = 0;

export async function runAdapterContract(options) {
  for (const name of options.cases ?? CONTRACT_CASES) await runContractCase(name, options);
}

export async function runContractCase(name, options = {}) {
  assert.ok(CONTRACT_CASES.includes(name), `Unknown adapter contract case: ${name}`);
  const cases = { tracer, 'provider-error': providerError, malformed, timeout, truncation, cancellation };
  return cases[name](options);
}

async function tracer(options = {}) {
  const anthropic = options.adapterKind === 'anthropic';
  const frames = anthropic ? anthropicTracerFrames() : [
    'data: {"id":"chat-1","choices":[{"delta":{"content":"Checking "}}]}\n\n',
    'data: {"id":"chat-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
    'data: {"id":"chat-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Berlin\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const received = {};
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.path = req.url;
      received.authorization = req.headers.authorization;
      received.apiKey = req.headers['x-api-key'];
      received.body = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  const request = {
    model: 'byok-contract-trace-model',
    stream: true,
    messages: [{ role: 'user', content: 'Weather?' }],
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }],
  };
  const { response, cleanup } = await start({ provider, options, request });
  try {
    assert.equal(response.status, 200, 'adapter contract tracer: expected a 200 response');
    const stream = await response.text();
    if (anthropic) {
      assert.match(stream, /"content":"Checking "/, 'adapter contract tracer: expected translated text');
      assert.match(stream, /"name":"weather"/, 'adapter contract tracer: expected translated tool call');
      assert.equal(stream.match(/data: \[DONE\]/g)?.length, 1, 'adapter contract tracer: expected one terminal marker');
      assert.equal(received.path, '/v1/messages', 'adapter contract tracer: expected messages path');
      assert.equal(received.apiKey, SECRET, 'adapter contract tracer: expected exact provider API key');
      assert.deepEqual(JSON.parse(received.body), {
        model: 'trace-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather?' }] }],
        max_tokens: 4096,
        stream: true,
        tools: [{ name: 'weather', input_schema: { type: 'object' } }],
      }, 'adapter contract tracer: expected translated request');
    } else {
      assert.equal(stream, frames.join(''), 'adapter contract tracer: expected exact SSE response bytes');
      assert.equal(received.path, '/v1/chat/completions', 'adapter contract tracer: expected chat-completions path');
      assert.equal(received.authorization, `Bearer ${SECRET}`, 'adapter contract tracer: expected exact provider Authorization');
      assert.deepEqual(
        received.body,
        Buffer.from(JSON.stringify({ ...request, model: 'trace-model' }), 'utf8'),
        'adapter contract tracer: expected exact routed request bytes',
      );
    }
  } finally {
    await cleanup();
  }
}

async function providerError(options = {}) {
  const events = [];
  const provider = http.createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `do not leak ${SECRET}` } }));
  });
  const { response, cleanup } = await start({
    provider,
    options,
    events,
    request: anthropicRequest('byok-contract-provider-error-model'),
  });
  try {
    const body = await response.text();
    assert.equal(response.status, 429, 'adapter contract provider-error: expected provider status');
    assert.equal(JSON.parse(body).error.category, 'rate-limit', 'adapter contract provider-error: expected typed failure');
    assert.ok(!body.includes(SECRET), 'adapter contract provider-error: response must redact provider details');
    assert.equal(events.filter((event) => event.type === 'error').length, 1, 'adapter contract provider-error: expected one terminal event');
  } finally {
    await cleanup();
  }
}

async function malformed(options = {}) {
  const events = [];
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_start\r\ndata: not-json\r\n\r\n');
  });
  const { response, cleanup } = await start({
    provider,
    options,
    events,
    request: anthropicRequest('byok-contract-malformed-model'),
  });
  try {
    const body = await response.text();
    assert.equal(response.status, 200, 'adapter contract malformed: expected streaming response');
    assert.equal(JSON.parse(dataPayloads(body)[0]).error.category, 'malformed-response', 'adapter contract malformed: expected typed SSE failure');
    assert.equal(body.match(/data: \[DONE\]/g)?.length, 1, 'adapter contract malformed: expected one terminal marker');
    assert.equal(events.filter((event) => event.type === 'error').length, 1, 'adapter contract malformed: expected one terminal event');
  } finally {
    await cleanup();
  }
}

async function timeout(options = {}) {
  const events = [];
  const timeoutMs = options.timeoutMs ?? 75;
  const provider = http.createServer(() => {});
  const request = options.adapterKind === 'anthropic'
    ? anthropicRequest('byok-contract-timeout-model')
    : { model: 'byok-contract-timeout-model', messages: [] };
  const { response, cleanup } = await start({ provider, options, timeoutMs, events, request });
  try {
    const body = await response.text();
    assert.equal(response.status, 502, 'adapter contract timeout: expected deterministic 502 response');
    assert.deepEqual(JSON.parse(body), {
      error: {
        category: 'timeout',
        message: `Provider produced no data for ${Math.round(timeoutMs / 1000)} seconds.`,
        retryable: true,
      },
    }, 'adapter contract timeout: expected deterministic timeout payload');
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
    if (options.adapterKind === 'anthropic') {
      res.write(anthropicFrame('message_start', {
        type: 'message_start', message: { id: 'msg_contract', model: 'truncated' },
      }));
      res.write(anthropicFrame('content_block_start', {
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      }));
      res.write(anthropicFrame('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' },
      }));
    } else {
      res.write('data: partial');
    }
    setTimeout(() => res.socket.destroy(), 20);
  });
  const request = options.adapterKind === 'anthropic'
    ? anthropicRequest('byok-contract-truncated-model')
    : { model: 'byok-contract-truncated-model', messages: [] };
  const { response, cleanup } = await start({ provider, options, events, request });
  try {
    assert.match(await response.text(), /partial/, 'adapter contract truncation: expected partial stream');
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
    res.write(options.adapterKind === 'anthropic'
      ? anthropicFrame('message_start', {
        type: 'message_start', message: { id: 'msg_cancel', model: 'cancelled' },
      })
      : 'data: partial\n\n');
  });
  const events = [];
  const request = options.adapterKind === 'anthropic'
    ? anthropicRequest('byok-contract-cancel-model')
    : { model: 'byok-contract-cancel-model', messages: [] };
  const { router, cleanup } = await start({ provider, options, events, request, returnRouter: true });
  const client = http.request({
    hostname: '127.0.0.1',
    port: router.address().port,
    path: '/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
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
  const catalog = buildCatalog([{
    id: 'contract',
    name: 'Contract',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiKey: SECRET,
    adapterKind: options.adapterKind ?? 'openai',
    models: [{ model }],
  }]);
  const adapter = options.adapter ?? options.adapterFactory?.({ timeoutMs });
  const router = createRouter({
    catalog,
    adapters: adapter ? { resolve: () => adapter } : undefined,
    onEvent: (event) => events.push(event),
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await listen(router);
  const cleanup = async () => {
    await router.shutdown();
    provider.closeAllConnections();
    await close(provider);
  };
  if (returnRouter) return { router, cleanup };
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    return { response, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function anthropicRequest(model) {
  return { model, messages: [{ role: 'user', content: 'go' }] };
}

function anthropicTracerFrames() {
  return [
    anthropicFrame('message_start', {
      type: 'message_start', message: { id: 'msg_contract', model: 'trace-model' },
    }, '\r\n'),
    anthropicFrame('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }, '\r\n'),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking ' },
    }, '\r\n'),
    anthropicFrame('content_block_stop', {
      type: 'content_block_stop', index: 0,
    }, '\r\n'),
    anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call_1', name: 'weather', input: {} },
    }, '\r\n'),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"city":"Berlin"}' },
    }, '\r\n'),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 1 }, '\r\n'),
    anthropicFrame('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'tool_use' },
    }, '\r\n'),
    anthropicFrame('message_stop', { type: 'message_stop' }, '\r\n'),
  ];
}

function anthropicFrame(event, data, newline = '\n') {
  return `event: ${event}${newline}data: ${JSON.stringify(data)}${newline}${newline}`;
}

function dataPayloads(stream) {
  return stream.split(/\r?\n/).filter((line) => line.startsWith('data: {')).map((line) => line.slice(6));
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
