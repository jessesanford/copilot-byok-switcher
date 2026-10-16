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
    assert.equal(response.status, 200, JSON.stringify(events));
    const stream = await response.text();
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
    ['image content', { stream: true, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }],
    ['late system message', { stream: true, messages: [{ role: 'user', content: 'go' }, { role: 'system', content: 'rules' }] }],
    ['malformed call arguments', {
      stream: true,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{' } }] },
      ],
    }],
    ['unmatched result', {
      stream: true,
      messages: [{ role: 'tool', tool_call_id: 'missing', content: '{}' }],
    }],
    ['invalid settings', { stream: true, messages: [{ role: 'user', content: 'go' }], temperature: 3 }],
    ['tool choice without tools', { stream: true, messages: [{ role: 'user', content: 'go' }], tool_choice: 'auto' }],
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

test('Gemini adapter translates conversations, tools, results, settings, and optional fields', async () => {
      let received;
      const provider = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frame({ candidates: [{ finishReason: 'STOP' }] }));
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
            messages: [
              { role: 'system', content: 'Be precise.' },
              { role: 'developer', content: [{ type: 'text', text: 'Use tools.' }] },
              { role: 'user', content: [{ type: 'input_text', text: 'Lookup Berlin.' }] },
              {
                role: 'assistant',
                content: 'Checking.',
                tool_calls: [{
                  id: 'call_weather',
                  type: 'function',
                  function: { name: 'weather', arguments: '{"city":"Berlin"}' },
                }],
              },
              { role: 'tool', tool_call_id: 'call_weather', content: '{"temperature":21}' },
              { role: 'assistant', content: 'It is 21C.' },
              { role: 'user', content: 'Thanks.' },
            ],
            tools: [{
              type: 'function',
              function: {
                name: 'weather',
                description: 'Get weather',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            }],
            tool_choice: { type: 'function', function: { name: 'weather' } },
            temperature: 0,
            top_p: 0.8,
            max_tokens: 128,
            n: 2,
            seed: 7,
            stop: ['END'],
          }),
        });

        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual(received, {
          systemInstruction: { parts: [{ text: 'Be precise.' }, { text: 'Use tools.' }] },
          contents: [
            { role: 'user', parts: [{ text: 'Lookup Berlin.' }] },
            {
              role: 'model',
              parts: [
                { text: 'Checking.' },
                { functionCall: { name: 'weather', args: { city: 'Berlin' } } },
              ],
            },
            {
              role: 'user',
              parts: [{ functionResponse: { name: 'weather', response: { temperature: 21 } } }],
            },
            { role: 'model', parts: [{ text: 'It is 21C.' }] },
            { role: 'user', parts: [{ text: 'Thanks.' }] },
          ],
          generationConfig: {
            temperature: 0,
            topP: 0.8,
            seed: 7,
            maxOutputTokens: 128,
            candidateCount: 2,
            stopSequences: ['END'],
          },
          tools: [{
            functionDeclarations: [{
              name: 'weather',
              description: 'Get weather',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            }],
          }],
          toolConfig: {
            functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['weather'] },
          },
        });
      } finally {
        await router.shutdown();
        provider.closeAllConnections();
        await close(provider);
      }
});

test('Gemini adapter translates legacy functions and omits unused optional fields', async () => {
      let received;
      const events = [];
      const provider = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frame({ candidates: [{ finishReason: 'STOP' }] }));
      });
      await listen(provider);
      const router = makeRouter(provider, events);
      await listen(router);

      try {
        const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'byok-sdc-gemini-picker',
            stream: true,
            messages: [
              { role: 'user', content: 'Lookup.' },
              { role: 'assistant', content: null, id: 'legacy_1', function_call: { name: 'lookup', arguments: '{}' } },
              { role: 'function', name: 'lookup', content: 'plain result' },
            ],
            functions: [{ name: 'lookup', parameters: { type: 'object' } }],
          }),
        });

        assert.equal(response.status, 200, JSON.stringify(events));
        assert.deepEqual(received, {
          contents: [
            { role: 'user', parts: [{ text: 'Lookup.' }] },
            { role: 'model', parts: [{ functionCall: { name: 'lookup', args: {} } }] },
            {
              role: 'user',
              parts: [{ functionResponse: { name: 'lookup', response: { result: 'plain result' } } }],
            },
          ],
          tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'object' } }] }],
        });
      } finally {
        await router.shutdown();
        provider.closeAllConnections();
        await close(provider);
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
