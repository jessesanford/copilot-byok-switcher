import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { assembleAdapterEvents } from '../src/adapters/events.mjs';
import { buildCatalog } from '../src/catalog.mjs';
import { createRouter } from '../src/router.mjs';
import { createUpstreamResolver } from '../src/upstream.mjs';

test('Gemini router acceptance selects the registered adapter and exact wire model', async () => {
  let received;
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'routed' }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }] })}\n\n`);
    res.end();
  });
  await listen(provider);
  const events = [];
  const catalog = buildCatalog([{
    id: 'sdc',
    name: 'Siemens SDC',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1beta`,
    apiKey: 'sdc-token',
    models: [{
      model: 'gemini-picker',
      wireModel: 'publishers/google/models/gemini-2.5-pro',
      adapterKind: 'gemini',
      endpointFamily: 'generate-content',
      authPolicy: { type: 'bearer' },
    }],
  }]);
  const router = createRouter({
    catalog,
    onEvent: (event) => events.push(event),
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'byok-sdc-gemini-picker',
        messages: [{ role: 'user', content: 'route me' }],
      }),
    });
    const stream = await response.text();

    assert.equal(response.status, 200);
    assert.equal(
      received.path,
      '/v1beta/models/publishers%2Fgoogle%2Fmodels%2Fgemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    assert.equal(received.authorization, 'Bearer sdc-token');
    assert.deepEqual(received.body, {
      contents: [{ role: 'user', parts: [{ text: 'route me' }] }],
    });
    assert.deepEqual(events.find(({ type }) => type === 'route'), {
      type: 'route',
      provider: 'sdc',
      model: 'gemini-picker',
      adapter: 'gemini',
    });
    assert.equal(assembleAdapterEvents(events.filter(({ type }) => ['text', 'finish'].includes(type))).text, 'routed');
    assert.equal(stream.match(/data: \[DONE\]/g)?.length, 1);
  } finally {
    await router.shutdown();
    provider.closeAllConnections();
    await close(provider);
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
