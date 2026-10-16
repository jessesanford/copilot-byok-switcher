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

test('Gemini adapter assembles ordered parallel function calls with stable identities', async () => {
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({
      candidates: [{
        index: 0,
        content: {
          parts: [
            { text: 'Checking ' },
            { functionCall: { name: 'weather', args: { city: 'Berlin' } } },
            { functionCall: { name: 'clock', args: { zone: 'Europe/Berlin' } } },
          ],
        },
      }],
    }));
    res.write(frame({
      candidates: [{
        index: 0,
        content: {
          parts: [
            { text: '' },
            { functionCall: { name: 'weather', args: { city: 'Berlin' } } },
            { functionCall: { name: 'clock', args: { zone: 'Europe/Berlin' } } },
          ],
        },
        finishReason: 'STOP',
      }],
    }));
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
        messages: [{ role: 'user', content: 'Use both.' }],
        tools: [
          { type: 'function', function: { name: 'weather', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'clock', parameters: { type: 'object' } } },
        ],
      }),
    });
    const stream = await response.text();
    const assembled = assembleAdapterEvents(events.filter(isAdapterEvent));

    assert.equal(response.status, 200);
    assert.equal(assembled.text, 'Checking ');
    assert.deepEqual(assembled.tools, [
      {
        id: 'gemini-call-0-1',
        index: 1,
        name: 'weather',
        arguments: '{"city":"Berlin"}',
        complete: true,
      },
      {
        id: 'gemini-call-0-2',
        index: 2,
        name: 'clock',
        arguments: '{"zone":"Europe/Berlin"}',
        complete: true,
      },
    ]);
    assert.deepEqual(assembled.finishes, ['tool-calls']);
    assert.deepEqual(clientToolCalls(stream), [
      {
        index: 1,
        id: 'gemini-call-0-1',
        name: 'weather',
        arguments: '{"city":"Berlin"}',
      },
      {
        index: 2,
        id: 'gemini-call-0-2',
        name: 'clock',
        arguments: '{"zone":"Europe/Berlin"}',
      },
    ]);
    assert.match(stream, /"finish_reason":"tool_calls"/);
    assert.equal(doneCount(stream), 1);
  } finally {
    await router.shutdown();
    provider.closeAllConnections();
    await close(provider);
  }
});

test('Gemini adapter preserves thought, usage, safety, and finish metadata without leaking hidden values', async () => {
  const signature = 'hidden-thought-signature';
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({
      candidates: [{
        index: 0,
        content: {
          parts: [
            { thought: true, text: 'private reasoning', thoughtSignature: signature },
            { text: 'visible answer' },
          ],
        },
        safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' }],
        finishReason: 'MAX_TOKENS',
      }],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 5,
        totalTokenCount: 10,
        cachedContentTokenCount: 1,
        thoughtsTokenCount: 2,
        toolUsePromptTokenCount: 4,
      },
    }));
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
        messages: [{ role: 'user', content: 'Think.' }],
      }),
    });
    const stream = await response.text();
    const assembled = assembleAdapterEvents(events.filter(isAdapterEvent));

    assert.equal(response.status, 200);
    assert.equal(assembled.text, 'visible answer');
    assert.equal(assembled.reasoning, 'private reasoning');
    assert.deepEqual(assembled.usage, [{
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 10,
      cachedInputTokens: 1,
      reasoningTokens: 2,
      toolUsePromptTokens: 4,
    }]);
    assert.deepEqual(assembled.finishes, ['length']);
    assert.deepEqual(assembled.metadata.gemini, [
      {
        candidate: {
          index: 0,
          safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' }],
        },
      },
      { thought: { candidateIndex: 0, partIndex: 0, signature } },
      { candidate: { index: 0, finishReason: 'MAX_TOKENS' } },
    ]);
    assert.match(stream, /visible answer/);
    assert.doesNotMatch(stream, /private reasoning|hidden-thought-signature/);
    assert.match(stream, /"finish_reason":"length"/);
    assert.equal(doneCount(stream), 1);
  } finally {
    await router.shutdown();
    provider.closeAllConnections();
    await close(provider);
  }
});

test('Gemini adapter turns prompt-feedback-only and safety-blocked responses into typed outcomes', async (t) => {
  for (const [name, response] of [
    ['prompt feedback', {
      promptFeedback: {
        blockReason: 'SAFETY',
        safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }],
      },
    }],
    ['candidate safety', {
      candidates: [{
        index: 0,
        content: { parts: [] },
        safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }],
        finishReason: 'SAFETY',
      }],
    }],
  ]) {
    await t.test(name, async () => {
      const provider = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frame(response));
      });
      await listen(provider);
      const events = [];
      const router = makeRouter(provider, events);
      await listen(router);
      try {
        const result = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'byok-sdc-gemini-picker',
            stream: true,
            messages: [{ role: 'user', content: 'Blocked.' }],
          }),
        });
        const stream = await result.text();
        const errors = events.filter(({ type }) => type === 'error');
        assert.equal(result.status, 200);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].error.category, 'upstream');
        assert.match(stream, /"error"/);
        assert.doesNotMatch(stream, /"finish_reason":"stop"/);
        assert.equal(doneCount(stream), 1);
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

function clientToolCalls(stream) {
  const calls = new Map();
  for (const payload of parseChunks(stream)) {
    for (const call of payload.choices[0].delta.tool_calls || []) {
      const current = calls.get(call.index) || {
        index: call.index,
        id: '',
        name: '',
        arguments: '',
      };
      if (call.id) current.id += call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      calls.set(call.index, current);
    }
  }
  return [...calls.values()].sort((left, right) => left.index - right.index);
}

function isAdapterEvent(event) {
  return [
    'text',
    'reasoning',
    'tool-fragment',
    'tool',
    'usage',
    'finish',
    'metadata',
    'error',
  ].includes(event.type);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
