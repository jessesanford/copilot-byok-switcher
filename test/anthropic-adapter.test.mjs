import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { buildCatalog } from '../src/catalog.mjs';
import { loadConfig } from '../src/config.mjs';
import { assembleAdapterEvents } from '../src/adapters/events.mjs';
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

test('Anthropic adapter assembles fragmented and interleaved native tool streams in provider order', async () => {
  const toolFrames = [
    anthropicFrame('message_start', { type: 'message_start', message: { id: 'msg_tools', model: 'claude-test' } }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'tool_b', name: 'second', input: {} },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"' },
    }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool_a', name: 'first', input: {} },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"n":' },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'Paris"}' },
    }),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 2 }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' },
    }),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    anthropicFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    anthropicFrame('message_stop', { type: 'message_stop' }),
  ];
  const { stream, events } = await relayAnthropicFrames(toolFrames);
  const chunks = parseChatChunks(stream);

  assert.deepEqual(chunks.map((chunk) => chunk.choices[0]), [
    { index: 0, delta: { role: 'assistant' }, finish_reason: null },
    {
      index: 0,
      delta: {
        tool_calls: [{
          index: 2, id: 'tool_b', type: 'function', function: { name: 'second', arguments: '' },
        }],
      },
      finish_reason: null,
    },
    {
      index: 0,
      delta: { tool_calls: [{ index: 2, function: { arguments: '{"city":"' } }] },
      finish_reason: null,
    },
    {
      index: 0,
      delta: {
        tool_calls: [{
          index: 0, id: 'tool_a', type: 'function', function: { name: 'first', arguments: '' },
        }],
      },
      finish_reason: null,
    },
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: '{"n":' } }] },
      finish_reason: null,
    },
    {
      index: 0,
      delta: { tool_calls: [{ index: 2, function: { arguments: 'Paris"}' } }] },
      finish_reason: null,
    },
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
      finish_reason: null,
    },
    { index: 0, delta: {}, finish_reason: 'tool_calls' },
  ]);
  assert.equal(stream.match(/data: \[DONE\]/g)?.length, 1);
  assert.deepEqual(assembleAdapterEvents(events).tools, [
    { id: 'tool_a', index: 0, name: 'first', arguments: '{"n":1}', complete: true },
    { id: 'tool_b', index: 2, name: 'second', arguments: '{"city":"Paris"}', complete: true },
  ]);
  assert.deepEqual(assembleAdapterEvents(events).finishes, ['tool-calls']);
});

test('Anthropic adapter preserves mixed text, empty tools, and message-stop terminal ordering', async () => {
  const mixedFrames = [
    anthropicFrame('message_start', { type: 'message_start', message: { id: 'msg_mixed', model: 'claude-test' } }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before' },
    }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tool_empty', name: 'empty', input: {} },
    }),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'after' },
    }),
    anthropicFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    anthropicFrame('message_stop', { type: 'message_stop' }),
  ];
  const { stream, events } = await relayAnthropicFrames(mixedFrames);

  assert.deepEqual(parseChatChunks(stream).map((chunk) => chunk.choices[0].delta), [
    { role: 'assistant' },
    { content: 'before' },
    {
      tool_calls: [{
        index: 1,
        id: 'tool_empty',
        type: 'function',
        function: { name: 'empty', arguments: '' },
      }],
    },
    { content: 'after' },
    {},
  ]);
  assert.ok(stream.indexOf('"content":"after"') < stream.indexOf('"finish_reason":"stop"'));
  assert.ok(stream.indexOf('"finish_reason":"stop"') < stream.indexOf('data: [DONE]'));
  assert.deepEqual(assembleAdapterEvents(events).tools, [
    { id: 'tool_empty', index: 1, name: 'empty', arguments: '', complete: true },
  ]);
  assert.deepEqual(assembleAdapterEvents(events).finishes, ['stop']);
});

test('Anthropic adapter maps max-token and unknown terminal reasons predictably', async () => {
  for (const [stopReason, chatReason, normalizedReason] of [
    ['max_tokens', 'length', 'length'],
    ['pause_turn', 'stop', 'stop'],
  ]) {
    const { stream, events } = await relayAnthropicFrames([
      anthropicFrame('message_start', {
        type: 'message_start', message: { id: `msg_${stopReason}`, model: 'claude-test' },
      }),
      anthropicFrame('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason } }),
      anthropicFrame('message_stop', { type: 'message_stop' }),
    ]);
    assert.equal(parseChatChunks(stream).at(-1).choices[0].finish_reason, chatReason);
    assert.deepEqual(assembleAdapterEvents(events).finishes, [normalizedReason]);
    assert.equal(stream.match(/data: \[DONE\]/g)?.length, 1);
  }
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
            nullable: { type: ['string', 'null'] },
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
        properties: {
          'x-private-name': { type: 'string' },
          nullable: { type: ['string', 'null'] },
        },
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
    tools: [
      { type: 'function', function: { name: 'first', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'second', parameters: { type: 'object' } } },
    ],
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

test('Anthropic adapter preserves schema dialect keywords and valid numeric and combinator constraints', async () => {
  const { body } = await captureAnthropicRequest({
    model: 'byok-anthropic-claude-test',
    tools: [{
      type: 'function',
      function: {
        name: 'measure',
        parameters: {
          type: 'object',
          definitions: {
            positive: { type: 'number', exclusiveMinimum: 0, multipleOf: 0.5 },
          },
          dependencies: {
            value: ['unit'],
            unit: { properties: { precision: { type: 'integer' } } },
          },
          properties: {
            value: {
              allOf: [
                { $ref: '#/definitions/positive' },
                { anyOf: [{ maximum: 10 }, { const: 20 }] },
              ],
            },
          },
        },
      },
    }],
    messages: [{ role: 'user', content: 'Measure it' }],
  });
  assert.deepEqual(body.tools[0].input_schema, {
    type: 'object',
    definitions: {
      positive: { type: 'number', exclusiveMinimum: 0, multipleOf: 0.5 },
    },
    dependencies: {
      value: ['unit'],
      unit: { properties: { precision: { type: 'integer' } } },
    },
    properties: {
      value: {
        allOf: [
          { $ref: '#/definitions/positive' },
          { anyOf: [{ maximum: 10 }, { const: 20 }] },
        ],
      },
    },
  });
});

test('Anthropic adapter preserves draft-07 tuple schemas and valid empty no-op arrays', async () => {
  const { body } = await captureAnthropicRequest({
    model: 'byok-anthropic-claude-test',
    tools: [{
      type: 'function',
      function: {
        name: 'tuple',
        description: 'Accept a tuple',
        parameters: {
          type: 'array',
          items: [{ type: 'string', pattern: '^ok$' }, { type: 'integer' }],
          additionalItems: false,
          required: [],
          dependencies: { legacy: [] },
          dependentRequired: { modern: [] },
          patternProperties: { '^x-': { type: 'string' } },
        },
      },
    }],
    messages: [{ role: 'user', content: 'Validate it' }],
  });
  assert.deepEqual(body.tools[0], {
    name: 'tuple',
    description: 'Accept a tuple',
    input_schema: {
      type: 'array',
      items: [{ type: 'string', pattern: '^ok$' }, { type: 'integer' }],
      additionalItems: false,
      required: [],
      dependencies: { legacy: [] },
      dependentRequired: { modern: [] },
      patternProperties: { '^x-': { type: 'string' } },
    },
  });
});

test('Anthropic adapter avoids generated legacy call ID collisions with later explicit calls', async () => {
  const { body } = await captureAnthropicRequest({
    model: 'byok-anthropic-claude-test',
    messages: [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: '', function_call: { name: 'first', arguments: '{}' } },
      { role: 'function', name: 'first', content: 'done' },
      { role: 'assistant', content: '', tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'second', arguments: '{}' },
      }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ],
  });
  assert.equal(body.messages[1].content[0].id, 'call_1_2');
  assert.equal(body.messages[2].content[0].tool_use_id, 'call_1_2');
  assert.equal(body.messages[3].content[0].id, 'call_1');
  assert.equal(body.messages[4].content[0].tool_use_id, 'call_1');
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
    ['missing modern arguments', {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go' } }] },
      ],
    }],
    ['missing legacy arguments', {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', function_call: { name: 'go' } },
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
    ['invalid tool call name', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'invalid name', arguments: '{}' } }],
        },
      ],
    }],
    ['invalid function definition name', {
      tools: [{
        type: 'function',
        function: { name: 'x'.repeat(65), parameters: { type: 'object' } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['missing function schema', {
      tools: [{ type: 'function', function: { name: 'go' } }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['non-positive schema multipleOf', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { type: 'number', multipleOf: 0 } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['empty schema combinator', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { type: 'object', allOf: [] } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['empty tuple items', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { type: 'array', items: [] } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['malformed schema properties', {
      tools: [{ type: 'function', function: { name: 'go', parameters: { type: 'object', properties: [] } } }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['malformed nested schema', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { type: 'object', properties: { value: 'string' } } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['malformed schema required', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { type: 'object', required: ['value', 1] } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['modern result for a legacy call', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_call_id: 'call_1',
          function_call: { name: 'go', arguments: '{}' },
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      ],
    }],
    ['legacy result for a modern call', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go', arguments: '{}' } }],
        },
        { role: 'function', tool_call_id: 'call_1', name: 'go', content: 'done' },
      ],
    }],
    ['invalid schema type name', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { type: 'record' } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['duplicate schema type name', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { type: ['string', 'string'] } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['empty schema enum', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { enum: [] } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['duplicate schema enum values', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { enum: ['same', 'same'] } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['duplicate required names', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { type: 'object', required: ['value', 'value'] } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['malformed schema pattern', {
      tools: [{
        type: 'function', function: { name: 'go', parameters: { type: 'string', pattern: '[' } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['duplicate property dependency names', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { dependencies: { value: ['other', 'other'] } } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['malformed patternProperties name', {
      tools: [{
        type: 'function', function: { name: 'go', parameters: { patternProperties: { '[': { type: 'string' } } } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['non-string function description', {
      tools: [{
        type: 'function',
        function: { name: 'go', description: 42, parameters: { type: 'object' } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['unknown schema keyword', {
      tools: [{
        type: 'function',
        function: { name: 'go', parameters: { type: 'object', unknownKeyword: true } },
      }],
      messages: [{ role: 'user', content: 'go' }],
    }],
    ['mixed legacy and modern assistant calls', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          function_call: { name: 'legacy', arguments: '{}' },
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'modern', arguments: '{}' } }],
        },
      ],
    }],
    ['ambiguous legacy result', {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', function_call: { name: 'go', arguments: '{}' } },
        { role: 'assistant', function_call: { name: 'go', arguments: '{}' } },
        { role: 'function', name: 'go', content: 'done' },
      ],
    }],
    ['modern result using call_id fallback metadata', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go', arguments: '{}' } }],
        },
        { role: 'tool', call_id: 'call_1', content: 'done' },
      ],
    }],
    ['modern result using id fallback metadata', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go', arguments: '{}' } }],
        },
        { role: 'tool', id: 'call_1', content: 'done' },
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
    ['auto tool choice without tools', {
      tool_choice: 'auto',
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
    ['empty standalone user turn', {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: [] },
      ],
    }],
    ['empty standalone assistant turn', {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
        { role: 'user', content: 'second' },
      ],
    }],
    ['mid-conversation system message', {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'system', content: 'late instruction' },
      ],
    }],
    ['unresolved tool call at conversation end', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go', arguments: '{}' } }],
        },
      ],
    }],
    ['tool call interrupted by user message', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go', arguments: '{}' } }],
        },
        { role: 'user', content: 'continue' },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      ],
    }],
    ['parallel tool results interrupted before completion', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'go', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'go', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'one' },
        { role: 'assistant', content: 'interrupt' },
        { role: 'tool', tool_call_id: 'call_2', content: 'two' },
      ],
    }],
    ['reused tool call ID after its result', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'again' },
      ],
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

function anthropicFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseChatChunks(stream) {
  return stream
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
}

async function relayAnthropicFrames(responseFrames) {
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of responseFrames) res.write(frame);
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
        model: 'byok-anthropic-claude-test',
        messages: [{ role: 'user', content: 'Use tools' }],
      }),
    });
    assert.equal(response.status, 200);
    return {
      stream: await response.text(),
      events: events.filter((event) => [
        'text', 'reasoning', 'tool-fragment', 'tool', 'usage', 'finish', 'metadata', 'error',
      ].includes(event.type)),
    };
  } finally {
    await close(router);
    await close(provider);
  }
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
