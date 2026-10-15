import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createAdapterRegistry } from '../src/adapters/registry.mjs';
import { buildCatalog } from '../src/catalog.mjs';
import { createRouter, mergeModels } from '../src/router.mjs';
import { createUpstreamResolver } from '../src/upstream.mjs';

test('mergeModels appends BYOK entries to the GitHub list', () => {
  const payload = JSON.stringify({ data: [{ id: 'gpt-5.5' }] });
  const merged = mergeModels(payload, [{ id: 'byok-acme-x' }]);

  assert.equal(merged.injected, 1);
  const parsed = JSON.parse(merged.payload);
  assert.deepEqual(parsed.data.map((model) => model.id), ['gpt-5.5', 'byok-acme-x']);
});

test('mergeModels supports a bare array payload', () => {
  const merged = mergeModels(JSON.stringify([{ id: 'gpt-5.5' }]), [{ id: 'byok-acme-x' }]);
  assert.equal(merged.injected, 1);
  assert.equal(JSON.parse(merged.payload).length, 2);
});

test('mergeModels leaves unexpected payloads untouched', () => {
  assert.deepEqual(mergeModels('not json', [{ id: 'x' }]), { payload: 'not json', injected: 0 });
  assert.deepEqual(mergeModels('{"error":"nope"}', [{ id: 'x' }]), { payload: '{"error":"nope"}', injected: 0 });
});

test('mergeModels does not duplicate entries already present', () => {
  const payload = JSON.stringify({ data: [{ id: 'byok-acme-x' }] });
  assert.equal(mergeModels(payload, [{ id: 'byok-acme-x' }]).injected, 0);
});

test('a BYOK request reaches the provider with the real model name', async () => {
  const received = [];
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ciao' } }] }));
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = provider.address().port;

  const catalog = buildCatalog([{
    id: 'acme',
    name: 'Acme',
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: 'provider-key',
    models: [{ model: 'acme-large' }],
  }]);

  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  const routerPort = router.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer github-token' },
      body: JSON.stringify({ model: 'byok-acme-acme-large', messages: [{ role: 'user', content: 'ciao' }] }),
    });

    assert.equal(response.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].path, '/v1/chat/completions');
    assert.equal(received[0].body.model, 'acme-large', 'the router maps the picker id');
    assert.equal(received[0].auth, 'Bearer provider-key', 'it uses the provider key');
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('the OpenAI adapter applies each declared authentication policy', async () => {
  const received = [];
  const provider = http.createServer((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    req.resume();
    res.writeHead(204).end();
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));

  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const catalog = buildCatalog([
    { id: 'none', name: 'None', baseUrl, apiKey: 'secret', authPolicy: { type: 'none' }, models: [{ model: 'model' }] },
    { id: 'header', name: 'Header', baseUrl, apiKey: 'secret', authPolicy: { type: 'x-api-key', header: 'x-provider-key' }, models: [{ model: 'model' }] },
    { id: 'query', name: 'Query', baseUrl, apiKey: 'secret', authPolicy: { type: 'api-key', query: 'api_key' }, models: [{ model: 'model' }] },
  ]);
  const router = createRouter({ catalog, upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }) });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));

  try {
    for (const id of ['none', 'header', 'query']) {
      const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: `byok-${id}-model`, messages: [] }),
      });
      assert.equal(response.status, 204);
    }
    assert.equal(received[0].headers.authorization, undefined);
    assert.equal(received[1].headers['x-provider-key'], 'secret');
    assert.equal(received[1].headers.authorization, undefined);
    assert.equal(received[2].path, '/v1/chat/completions?api_key=secret');
    assert.equal(received[2].headers.authorization, undefined);
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('the default OpenAI adapter preserves a tool stream request and response bytes', async () => {
  const frames = [
    'data: {"id":"chat-1","choices":[{"delta":{"content":"Checking "}}]}\n\n',
    'data: {"id":"chat-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
    'data: {"id":"chat-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Berlin\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const expectedStream = frames.join('');
  let received;
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = { path: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));

  const catalog = buildCatalog([{
    id: 'trace', name: 'Trace', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiKey: 'k', models: [{ model: 'trace-model' }],
  }]);
  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));

  const request = {
    model: 'byok-trace-trace-model',
    stream: true,
    messages: [{ role: 'user', content: 'Weather?' }],
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }],
  };

  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    assert.equal(await response.text(), expectedStream);
    assert.equal(received.path, '/v1/chat/completions');
    assert.deepEqual(received.body, { ...request, model: 'trace-model' });
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('Responses requests translate prior assistant tool calls into function call items', async () => {
  let received;
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'response-1', output: [] }));
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const catalog = buildCatalog([{
    id: 'responses', name: 'Responses', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiKey: 'k', models: [{ model: 'gpt-6.1-sol', endpointFamily: 'responses' }],
  }]);
  const router = createRouter({ catalog, upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }) });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'byok-responses-gpt-6-1-sol',
        messages: [
          { role: 'user', content: 'What is today\'s date?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'date', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '2026-10-15' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(received.input[1].content[0].type, 'function_call');
    assert.deepEqual(received.input[1].content[0], { type: 'function_call', call_id: 'call_1', name: 'date', arguments: '{}' });
    assert.deepEqual(received.input[2], { type: 'function_call_output', call_id: 'call_1', output: '2026-10-15' });
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('the adapter registry rejects duplicate kinds', () => {
  const adapter = { kind: 'native', forward() {} };
  assert.throws(
    () => createAdapterRegistry([adapter, { ...adapter }]),
    /Adapter kind "native" is already registered/
  );
});

test('createRouter accepts an adapter registry extension', async () => {
  let forwarded = false;
  const catalog = buildCatalog([{
    id: 'native', name: 'Native', baseUrl: 'https://provider.invalid/v1',
    apiKey: 'k', adapterKind: 'native', models: [{ model: 'native-model' }],
  }]);
  const adapters = createAdapterRegistry([{
    kind: 'native',
    forward({ res }) {
      forwarded = true;
      res.writeHead(204).end();
    },
  }]);
  const router = createRouter({
    catalog, adapters,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-native-native-model', messages: [] }),
    });
    assert.equal(response.status, 204);
    assert.equal(forwarded, true);
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
  }
});

test('an unavailable explicit adapter fails before provider traffic', async () => {
  let providerRequests = 0;
  const provider = http.createServer((_req, res) => {
    providerRequests += 1;
    res.writeHead(500).end();
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const catalog = buildCatalog([{
    id: 'native', name: 'Native', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiKey: 'k', adapterKind: 'unavailable', models: [{ model: 'native-model' }],
  }]);
  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-native-native-model', messages: [] }),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: {
      code: 'unsupported_adapter',
      adapter: 'unavailable',
      message: 'Unsupported provider adapter "unavailable". Register it before routing requests.',
    } });
    assert.equal(providerRequests, 0);
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('an unknown BYOK id fails clearly instead of reaching GitHub', async () => {
  const catalog = buildCatalog([]);
  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  const port = router.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-ghost-model', messages: [] }),
    });

    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.match(payload.error.message, /Unknown BYOK model/);
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
  }
});

test('a provider timeout emits exactly one typed timeout event without secrets', async () => {
  process.env.COPILOT_BYOK_PROVIDER_TIMEOUT_MS = '300';
  const { createRouter: freshRouter } = await import(`../src/router.mjs?timeout-case`);

  const stalling = http.createServer(() => { /* never responds */ });
  await new Promise((resolve) => stalling.listen(0, '127.0.0.1', resolve));

  const catalog = buildCatalog([{
    id: 'slow',
    name: 'Slow',
    baseUrl: `http://127.0.0.1:${stalling.address().port}/v1`,
    apiKey: 'k',
    models: [{ model: 'slow-model' }],
  }]);

  const events = [];
  const router = freshRouter({
    catalog,
    onEvent: (event) => events.push(event),
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-slow-slow-model', messages: [] }),
    });

    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /no data for/);
    const errors = events.filter((event) => event.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.category, 'timeout');
    assert.ok(!JSON.stringify(errors).includes('k'));
  } finally {
    delete process.env.COPILOT_BYOK_PROVIDER_TIMEOUT_MS;
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    stalling.closeAllConnections();
    await new Promise((resolve) => stalling.close(resolve));
  }
});

test('a provider that dies mid-stream ends the response instead of hanging', async () => {
  const dying = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"par'); // truncated on purpose
    setTimeout(() => res.socket.destroy(), 50);
  });
  await new Promise((resolve) => dying.listen(0, '127.0.0.1', resolve));

  const events = [];
  const catalog = buildCatalog([{
    id: 'flaky',
    name: 'Flaky',
    baseUrl: `http://127.0.0.1:${dying.address().port}/v1`,
    apiKey: 'k',
    models: [{ model: 'flaky-model' }],
  }]);

  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
    onEvent: (event) => events.push(event),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-flaky-flaky-model', messages: [] }),
    });

    // Must settle rather than hang: the body ends even though the provider vanished.
    const text = await response.text();
    assert.match(text, /par$/);
    const errors = events.filter((event) => event.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.category, 'truncated');
    assert.ok(!JSON.stringify(errors).includes('secret-key'));
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    dying.closeAllConnections();
    await new Promise((resolve) => dying.close(resolve));
  }
});

test('custom provider headers cannot override host or content-length', async () => {
  let seen;
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen = { headers: req.headers, length: body.length };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const port = provider.address().port;

  const catalog = buildCatalog([{
    id: 'gw',
    name: 'Gateway',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'k',
    headers: { 'X-Tenant-Id': 'team', host: 'evil.example.com', 'content-length': '99999' },
    models: [{ model: 'm' }],
  }]);

  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));

  try {
    await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-gw-m', messages: [] }),
    });

    assert.equal(seen.headers['x-tenant-id'], 'team', 'genuine custom headers still pass');
    assert.equal(seen.headers.host, `127.0.0.1:${port}`, 'host must stay correct');
    assert.equal(Number(seen.headers['content-length']), seen.length, 'content-length must match the body');
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('the configured reasoning effort is applied to the provider request', async () => {
  let seen;
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const port = provider.address().port;

  const catalog = buildCatalog([{
    id: 'acme',
    name: 'Acme',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'k',
    models: [
      { model: 'thinker', reasoningEffort: 'xhigh' },
      { model: 'plain' },
    ],
  }]);

  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${router.address().port}/chat/completions`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-acme-thinker', messages: [] }),
    });
    assert.equal(seen.reasoning_effort, 'xhigh', 'each model carries its own level');

    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-acme-plain', messages: [] }),
    });
    assert.equal(seen.reasoning_effort, undefined, 'models without a level are untouched');
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('an effort already present in the request is not overwritten', async () => {
  let seen;
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { seen = JSON.parse(body); res.writeHead(200).end('{}'); });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));

  const catalog = buildCatalog([{
    id: 'acme', name: 'Acme', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiKey: 'k', models: [{ model: 'thinker', reasoningEffort: 'low' }],
  }]);

  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));

  try {
    await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-acme-thinker', messages: [], reasoning_effort: 'max' }),
    });

    assert.equal(seen.reasoning_effort, 'max', 'a caller that asked explicitly wins');
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('an unsupported effort steps down instead of failing the request', async () => {
  const attempts = [];
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      attempts.push(parsed.reasoning_effort);
      // Mirrors GLM-5.2: xhigh is rejected, high is fine.
      if (parsed.reasoning_effort === 'xhigh') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ detail: 'Invalid request: reasoning_effort' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));

  const events = [];
  const catalog = buildCatalog([{
    id: 'acme', name: 'Acme', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiKey: 'k', models: [{ model: 'thinker', reasoningEffort: 'xhigh' }],
  }]);

  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
    onEvent: (event) => events.push(event),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${router.address().port}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-acme-thinker', messages: [] }),
    });

    assert.equal(response.status, 200, 'the client sees a working request');
    assert.deepEqual(attempts, ['xhigh', 'high'], 'stepped down one level');
    const notice = events.find((event) => /rejected reasoning effort/.test(event.message || ''));
    assert.match(notice.message, /"xhigh".*retrying with "high"/);

    // The rejection is remembered: the next call starts at the level that worked.
    attempts.length = 0;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-acme-thinker', messages: [] }),
    });
    assert.deepEqual(attempts, ['high'], 'no wasted round trip on the rejected level');
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('when the CLI starts sending an effort, the user choice wins over the config', async () => {
  const seen = [];
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(body).reasoning_effort);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));

  const catalog = buildCatalog([{
    id: 'acme', name: 'Acme', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiKey: 'k', models: [{ model: 'thinker', reasoningEffort: 'low' }],
  }]);

  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${router.address().port}/chat/completions`;

  try {
    // Today: the CLI sends nothing, so the configured level is applied.
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-acme-thinker', messages: [] }),
    });

    // After the CLI is fixed: what the user picked must not be overridden.
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-acme-thinker', messages: [], reasoning_effort: 'high' }),
    });

    assert.deepEqual(seen, ['low', 'high']);
  } finally {
    router.closeAllConnections();
    await new Promise((resolve) => router.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('router rejects a request body over 64 MiB with one typed terminal error', async () => {
  const events = [];
  const router = createRouter({ catalog: buildCatalog([]), onEvent: (event) => events.push(event), transport: http,
    upstream: createUpstreamResolver({ explicit: 'http://127.0.0.1:1' }) });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/anything`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(64 * 1024 * 1024 + 1),
    });
    assert.equal(response.status, 413);
    assert.equal(events.filter((event) => event.type === 'error').length, 1);
    assert.equal(events.find((event) => event.type === 'error').error.category, 'invalid-request');
  } finally { await router.shutdown(); }
});

test('GET /models rejects an 8 MiB catalog with one typed terminal error', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('x'.repeat(8 * 1024 * 1024 + 1));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const events = [];
  const router = createRouter({ catalog: buildCatalog([]), onEvent: (event) => events.push(event), transport: http,
    upstream: createUpstreamResolver({ explicit: `http://127.0.0.1:${upstream.address().port}` }) });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/models`);
    assert.equal(response.status, 502);
    const error = events.find((event) => event.type === 'error');
    assert.equal(error.error.category, 'invalid-request');
    assert.equal(events.filter((event) => event.type === 'error').length, 1);
  } finally { await router.shutdown(); await new Promise((resolve) => upstream.close(resolve)); }
});

test('client disconnect cancels the provider once and emits no post-cancel terminal event', async () => {
  let aborts = 0;
  let providerStarted;
  const providerReady = new Promise((resolve) => { providerStarted = resolve; });
  const provider = http.createServer((req, res) => {
    providerStarted();
    req.on('aborted', () => { aborts += 1; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\\n\\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const events = [];
  const catalog = buildCatalog([{ id: 'cancel', name: 'Cancel', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'secret', models: [{ model: 'm' }] }]);
  const router = createRouter({ catalog, onEvent: (event) => events.push(event), upstream: createUpstreamResolver({ explicit: 'http://127.0.0.1:1' }) });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  const request = http.request({ hostname: '127.0.0.1', port: router.address().port, path: '/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } });
  request.end(JSON.stringify({ model: 'byok-cancel-m', messages: [] }));
  await providerReady;
  await new Promise((resolve) => setTimeout(resolve, 20));
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(aborts, 1);
  assert.ok(events.every((event) => event.type !== 'error' || event.error?.category === 'cancelled'));
  await router.shutdown(); await new Promise((resolve) => provider.close(resolve));
});

test('shutdown aborts active work before sockets and is idempotent', async () => {
  let aborts = 0;
  let providerStarted;
  const providerReady = new Promise((resolve) => { providerStarted = resolve; });
  const provider = http.createServer((req) => {
    providerStarted();
    req.on('aborted', () => { aborts += 1; });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const catalog = buildCatalog([{ id: 'stop', name: 'Stop', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'secret', models: [{ model: 'm' }] }]);
  const router = createRouter({ catalog, upstream: createUpstreamResolver({ explicit: 'http://127.0.0.1:1' }) });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'byok-stop-m', messages: [] }) }).catch(() => {});
  await providerReady;
  const first = router.shutdown();
  const second = router.shutdown();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(aborts, 1);
  await new Promise((resolve) => provider.close(resolve));
});

test('provider status failures preserve raw response bytes and headers', async () => {
  const body = JSON.stringify({ error: { message: 'provider detail' } });
  const provider = http.createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
    res.end(body);
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const events = [];
  const catalog = buildCatalog([{ id: 'reject', name: 'Reject', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'secret-key', models: [{ model: 'reject-model' }] }]);
  const router = createRouter({ catalog, onEvent: (event) => events.push(event), upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }) });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'byok-reject-reject-model', messages: [] }) });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '7');
    assert.equal(await response.text(), body);
    assert.ok(events.every((event) => !JSON.stringify(event).includes('secret-key')));
  } finally {
    await router.shutdown();
    await new Promise((resolve) => provider.close(resolve));
  }
});
