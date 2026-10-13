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
    apiKey: 'k', adapterKind: 'anthropic', models: [{ model: 'native-model' }],
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
      adapter: 'anthropic',
      message: 'Unsupported provider adapter "anthropic". Register it before routing requests.',
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

test('a provider that accepts the connection and stalls does not hang forever', async () => {
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

  const router = freshRouter({
    catalog,
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
    assert.ok(events.some((event) => /interrupted|aborted/.test(event.message || '')));
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
