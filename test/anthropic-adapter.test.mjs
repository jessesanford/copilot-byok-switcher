import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { buildCatalog } from '../src/catalog.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRouter } from '../src/router.mjs';
import { createUpstreamResolver } from '../src/upstream.mjs';

test('Anthropic providers default to the native Anthropic adapter', async () => {
  const { providers } = await loadConfig({ env: {} });
  assert.equal(providers.find((provider) => provider.id === 'anthropic').adapterKind, 'anthropic');
});

const frames = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

test('Anthropic adapter maps text requests and SSE deltas to Copilot-compatible chunks', async () => {
  let received;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  await listen(provider);
  const events = [];
  const router = makeRouter(provider, events);
  await listen(router);
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-anthropic-claude-test', max_tokens: 21, messages: [
        { role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello?' },
      ] }),
    });
    const stream = await response.text();
    assert.equal(response.status, 200);
    assert.equal(received.path, '/v1/messages');
    assert.equal(received.headers['x-api-key'], 'anthropic-key');
    assert.equal(received.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(received.body, {
      model: 'claude-test', system: 'Be brief.', messages: [{ role: 'user', content: 'Hello?' }], max_tokens: 21, stream: true,
    });
    assert.match(stream, /"role":"assistant"/);
    assert.match(stream, /"content":"Hello "/);
    assert.match(stream, /"content":"world"/);
    assert.match(stream, /"finish_reason":"stop"/);
    assert.match(stream, /data: \[DONE\]/);
    assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => event.text), ['Hello ', 'world']);
  } finally { await close(router); await close(provider); }
});

test('Anthropic adapter rejects unsupported message content without provider traffic', async () => {
  let requests = 0;
  const provider = http.createServer((_req, res) => { requests += 1; res.writeHead(500).end(); });
  await listen(provider);
  const events = [];
  const router = makeRouter(provider, events);
  await listen(router);
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'byok-anthropic-claude-test', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }),
    });
    assert.equal(response.status, 400);
    assert.equal(requests, 0);
    assert.equal((await response.json()).error.category, 'invalid-request');
    assert.equal(events.find((event) => event.type === 'error').error.category, 'invalid-request');
  } finally { await close(router); await close(provider); }
});

function makeRouter(provider, events) {
  return createRouter({
    catalog: buildCatalog([{ id: 'anthropic', name: 'Anthropic', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'anthropic-key', adapterKind: 'anthropic', models: [{ model: 'claude-test' }] }]),
    onEvent: (event) => events.push(event),
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
}

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); }
async function close(server) { await server.shutdown?.(); server.closeAllConnections?.(); if (server.listening) await new Promise((resolve) => server.close(resolve)); }
