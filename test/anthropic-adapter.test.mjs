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
      model: 'claude-test',
      system: [{ type: 'text', text: 'Be brief.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello?' }] }],
      max_tokens: 21,
      stream: true,
    });
    assert.match(stream, /"role":"assistant"/);
    assert.match(stream, /"content":"Hello "/);
    assert.match(stream, /"content":"world"/);
    assert.match(stream, /"finish_reason":"stop"/);
    assert.match(stream, /data: \[DONE\]/);
    assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => event.text), ['Hello ', 'world']);
  } finally { await close(router); await close(provider); }
});

test('Anthropic adapter translates modern tools, results, schemas, and choices without private fields', async () => {
  const { body } = await captureAnthropicRequest({
    model: 'byok-anthropic-claude-test',
    private: 'payload-secret',
    max_completion_tokens: 100_000,
    tool_choice: { type: 'function', function: { name: 'lookup', private: true }, private: true },
    tools: [{
      type: 'function',
      private: true,
      function: {
        name: 'lookup',
        description: 'Look up a record',
        private: true,
        parameters: {
          type: 'object',
          properties: {
            'x-private-name': { type: 'string', private: true },
          },
          required: ['x-private-name'],
          private: true,
        },
      },
    }],
    messages: [
      { role: 'system', content: 'System', private: true },
      { role: 'developer', content: [{ type: 'text', text: 'Developer', private: true }] },
      { role: 'user', content: 'Find it', private: true },
      {
        role: 'assistant',
        content: null,
        private: true,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          private: true,
          function: { name: 'lookup', arguments: '{"x-private-name":"value"}', private: true },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        private: true,
        content: [{ type: 'text', text: 'found', private: true }],
      },
    ],
  }, { maxOutputTokens: 8192 });

  assert.deepEqual(body, {
    model: 'claude-test',
    system: [{ type: 'text', text: 'System' }, { type: 'text', text: 'Developer' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Find it' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_1',
          name: 'lookup',
          input: { 'x-private-name': 'value' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: [{ type: 'text', text: 'found' }],
        }],
      },
    ],
    max_tokens: 8192,
    stream: true,
    tools: [{
      name: 'lookup',
      description: 'Look up a record',
      input_schema: {
        type: 'object',
        properties: { 'x-private-name': { type: 'string' } },
        required: ['x-private-name'],
      },
    }],
    tool_choice: { type: 'tool', name: 'lookup' },
  });
  assert.doesNotMatch(JSON.stringify(body), /"private":|payload-secret/);
});

test('Anthropic adapter preserves legacy call identity and deterministic result matching', async () => {
  const { body } = await captureAnthropicRequest({
    model: 'byok-anthropic-claude-test',
    functions: [{ name: 'lookup', parameters: { type: 'object' } }],
    tool_choice: 'required',
    messages: [
      { role: 'user', content: 'Find it' },
      {
        role: 'assistant',
        id: 'legacy_explicit',
        content: '',
        function_call: { name: 'lookup', arguments: '{"id":1}' },
      },
      { role: 'function', tool_call_id: 'legacy_explicit', name: 'lookup', content: 'first' },
      { role: 'assistant', content: '', function_call: { name: 'lookup', arguments: '{"id":2}' } },
      { role: 'function', name: 'lookup', content: 'found' },
    ],
  });
  assert.deepEqual(body.messages.slice(1), [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'legacy_explicit', name: 'lookup', input: { id: 1 } }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'legacy_explicit',
        content: [{ type: 'text', text: 'first' }],
      }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_3', name: 'lookup', input: { id: 2 } }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_3',
        content: [{ type: 'text', text: 'found' }],
      }],
    },
  ]);
  assert.deepEqual(body.tools, [{ name: 'lookup', input_schema: { type: 'object' } }]);
  assert.deepEqual(body.tool_choice, { type: 'any' });
});

test('Anthropic adapter translates base64 user and tool-result images in order', async () => {
  const { body } = await captureAnthropicRequest({
    model: 'byok-anthropic-claude-test',
    tool_choice: 'auto',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high', private: true } },
        ],
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'first', arguments: '{}' } },
          { id: 'call_b', type: 'function', function: { name: 'second', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: null },
      {
        role: 'tool',
        tool_call_id: 'call_b',
        content: [
          { type: 'text', text: 'image' },
          { type: 'input_image', image_url: 'data:image/webp;base64,AA==' },
        ],
      },
    ],
  });
  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_a', name: 'first', input: {} },
        { type: 'tool_use', id: 'call_b', name: 'second', input: {} },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_a', content: '' }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_b',
        content: [
          { type: 'text', text: 'image' },
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'AA==' } },
        ],
      }],
    },
  ]);
  assert.deepEqual(body.tool_choice, { type: 'auto' });
});

test('Anthropic adapter rejects malformed and unsupported request shapes without provider traffic', async (t) => {
  const invalidPayloads = [
    ['reported tool-role failure without a call', {
      messages: [{ role: 'tool', tool_call_id: 'missing', content: 'result' }],
    }],
    ['malformed arguments', {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go', arguments: '{' } }] },
      ],
    }],
    ['missing call ID', {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'go', arguments: '{}' } }] },
      ],
    }],
    ['missing function name', {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { arguments: '{}' } }] },
      ],
    }],
    ['missing function schema', {
      tools: [{ type: 'function', function: { name: 'go' } }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['ambiguous legacy result', {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', function_call: { name: 'go', arguments: '{}' } },
        { role: 'assistant', function_call: { name: 'go', arguments: '{}' } },
        { role: 'function', name: 'go', content: 'done' },
      ],
    }],
    ['unsupported image URL', {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }],
    }],
    ['malformed image data', {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,not-base64' } }] }],
    }],
    ['file image', {
      messages: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }],
    }],
    ['unsupported image media type', {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,AA==' } }] }],
    }],
    ['unsupported tool choice', {
      tool_choice: 'none',
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['required tool choice without tools', {
      tool_choice: 'required',
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['tool choice missing a name', {
      tool_choice: { type: 'function', function: {} },
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['tool choice naming an undefined function', {
      tool_choice: { type: 'function', function: { name: 'missing' } },
      tools: [{ type: 'function', function: { name: 'go', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['unknown tool choice shape', {
      tool_choice: { type: 'custom', name: 'go' },
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['empty conversation', {
      messages: [{ role: 'assistant', content: null }],
    }],
  ];
  for (const [name, payload] of invalidPayloads) {
    await t.test(name, async () => {
      const { response, requests, events } = await sendAnthropicRequest({
        model: 'byok-anthropic-claude-test',
        ...payload,
      });
      assert.equal(response.status, 400);
      assert.equal(requests(), 0);
      assert.equal((await response.json()).error.category, 'invalid-request');
      assert.equal(events.find((event) => event.type === 'error').error.category, 'invalid-request');
    });
  }
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

async function captureAnthropicRequest(payload, model = {}) {
  let body;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      body = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  await listen(provider);
  const router = makeRouter(provider, [], model);
  await listen(router);
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    await response.text();
    return { body };
  } finally {
    await close(router);
    await close(provider);
  }
}

async function sendAnthropicRequest(payload) {
  let requestCount = 0;
  const provider = http.createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(500).end();
  });
  await listen(provider);
  const events = [];
  const router = makeRouter(provider, events);
  await listen(router);
  const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await close(router);
  await close(provider);
  return { response, requests: () => requestCount, events };
}

function makeRouter(provider, events, model = {}) {
  return createRouter({
    catalog: buildCatalog([{ id: 'anthropic', name: 'Anthropic', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'anthropic-key', adapterKind: 'anthropic', models: [{ model: 'claude-test', ...model }] }]),
    onEvent: (event) => events.push(event),
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
}

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); }
async function close(server) { await server.shutdown?.(); server.closeAllConnections?.(); if (server.listening) await new Promise((resolve) => server.close(resolve)); }
