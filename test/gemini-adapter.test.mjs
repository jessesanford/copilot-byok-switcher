import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { assembleAdapterEvents } from '../src/adapters/events.mjs';
import { buildCatalog } from '../src/catalog.mjs';
import { createRouter } from '../src/router.mjs';
import { createUpstreamResolver } from '../src/upstream.mjs';

test('Gemini adapter sends native SDC text requests and relays text through STOP', async () => {
  let received;
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      path: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] }));
    res.write(frame({ candidates: [{ content: { parts: [{ text: 'Gemini' }] }, finishReason: 'STOP' }] }));
    res.end();
  });
  await listen(provider);
  const events = [];
  const router = makeRouter(provider, events);
  await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'byok-sdc-gemini-picker',
        stream: true,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    });
    const stream = await response.text();

    assert.equal(response.status, 200);
    assert.equal(received.path, '/v1beta/models/accounts%2Fteam%2Fgemini-wire:streamGenerateContent?alt=sse');
    assert.equal(received.headers.authorization, 'Bearer gemini-secret');
    assert.equal(received.headers.accept, 'text/event-stream');
    assert.deepEqual(received.body, {
      contents: [{ role: 'user', parts: [{ text: 'Say hello.' }] }],
    });
    assert.deepEqual(parseChunks(stream).map(({ choices }) => choices[0]), [
      { index: 0, delta: { role: 'assistant' }, finish_reason: null },
      { index: 0, delta: { content: 'Hello ' }, finish_reason: null },
      { index: 0, delta: { content: 'Gemini' }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'stop' },
    ]);
    assert.ok(parseChunks(stream).every(({ id, model }) => (
      typeof id === 'string' && id.startsWith('gemini-') && model === 'accounts/team/gemini-wire'
    )));
    assert.equal(doneCount(stream), 1);
    const assembled = assembleAdapterEvents(events.filter(isAdapterEvent));
    assert.equal(assembled.text, 'Hello Gemini');
    assert.deepEqual(assembled.finishes, ['stop']);
  } finally {
    await router.shutdown();
    provider.closeAllConnections();
    await close(provider);
  }
});

test('Gemini adapter rejects unsupported request shapes before provider traffic', async (t) => {
  const cases = [
    ['missing stream', { messages: [{ role: 'user', content: 'go' }] }],
    ['non-streaming', { stream: false, messages: [{ role: 'user', content: 'go' }] }],
    ['multiple messages', { stream: true, messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }] }],
    ['system messages', { stream: true, messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'go' }] }],
    ['image content', { stream: true, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }],
    ['tools', { stream: true, messages: [{ role: 'user', content: 'go' }], tools: [] }],
    ['settings', { stream: true, messages: [{ role: 'user', content: 'go' }], temperature: 0 }],
  ];

  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      let requests = 0;
      const provider = http.createServer((_req, res) => {
        requests += 1;
        res.writeHead(500).end();
      });
      await listen(provider);
      const events = [];
      const router = makeRouter(provider, events);
      await listen(router);
      try {
        const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'byok-sdc-gemini-picker', ...payload }),
        });
        assert.equal(response.status, 400);
        assert.equal(requests, 0);
        assert.equal((await response.json()).error.category, 'invalid-request');
        assert.equal(events.filter(({ type }) => type === 'error').length, 1);
      } finally {
        await router.shutdown();
        provider.closeAllConnections();
        await close(provider);
      }
    });
  }
});

function makeRouter(provider, events) {
  return createRouter({
    catalog: buildCatalog([{
      id: 'sdc',
      name: 'Siemens SDC',
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1beta`,
      apiKey: 'gemini-secret',
      adapterKind: 'gemini',
      endpointFamily: 'generate-content',
      authPolicy: { type: 'bearer' },
      models: [{ model: 'gemini-picker', wireModel: 'accounts/team/gemini-wire' }],
    }]),
    onEvent: (event) => events.push(event),
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
}

function frame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function parseChunks(stream) {
  return stream.split(/\r?\n/)
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
}

function doneCount(stream) {
  return stream.match(/data: \[DONE\]/g)?.length || 0;
}

function isAdapterEvent(event) {
  return ['text', 'finish', 'error'].includes(event.type);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
