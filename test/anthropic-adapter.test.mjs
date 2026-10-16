import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { buildCatalog } from '../src/catalog.mjs';
import { loadConfig } from '../src/config.mjs';
import { createAnthropicAdapter } from '../src/adapters/anthropic.mjs';
import { assembleAdapterEvents } from '../src/adapters/events.mjs';
import { createRouter } from '../src/router.mjs';
import { createUpstreamResolver } from '../src/upstream.mjs';

test('Anthropic providers default to the native Anthropic adapter', async () => {
  const { providers } = await loadConfig({ env: {} });
  assert.equal(providers.find((provider) => provider.id === 'anthropic').adapterKind, 'anthropic');
});

const frames = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
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

test('Anthropic adapter maps native HTTP failures to safe typed responses', async () => {
  const provider = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'secret provider detail anthropic-key' } }));
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
        messages: [{ role: 'user', content: 'go' }],
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(body), {
      error: {
        category: 'authentication',
        message: 'The Anthropic provider rejected its credentials.',
        retryable: false,
        status: 401,
      },
    });
    assert.doesNotMatch(body, /secret provider detail|anthropic-key/);
    assert.equal(events.filter((event) => event.type === 'error').length, 1);
  } finally {
    await close(router);
    await close(provider);
  }
});

test('Anthropic adapter maps HTTP 413 to a non-retryable invalid request', async () => {
  const provider = http.createServer((_req, res) => {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'sensitive request details' } }));
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
        messages: [{ role: 'user', content: 'go' }],
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(body).error, {
      category: 'invalid-request',
      message: 'The Anthropic provider rejected the request as too large.',
      retryable: false,
      status: 413,
    });
    assert.doesNotMatch(body, /sensitive request details/);
    assert.equal(events.filter((event) => event.type === 'error').length, 1);
  } finally {
    await close(router);
    await close(provider);
  }
});

test('Anthropic adapter preserves partial output then terminates once on native SSE errors', async () => {
  const { stream, events } = await relayAnthropicFrames([
    anthropicFrame('message_start', {
      type: 'message_start', message: { id: 'msg_error', model: 'claude-test' },
    }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' },
    }),
    anthropicFrame('error', {
      type: 'error',
      error: { type: 'overloaded_error', message: 'do not expose provider internals' },
    }),
    anthropicFrame('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn' },
    }),
    anthropicFrame('message_stop', { type: 'message_stop' }),
  ]);
  const payloads = parseSsePayloads(stream);
  const error = payloads.find((payload) => payload.error)?.error;

  assert.match(stream, /"content":"partial"/);
  assert.deepEqual(error, {
    category: 'upstream',
    message: 'The Anthropic provider stream failed.',
    retryable: true,
  });
  assert.equal(stream.match(/data: \[DONE\]/g)?.length, 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.filter((event) => event.type === 'finish').length, 0);
  assert.doesNotMatch(stream, /provider internals/);
});

test('Anthropic adapter does not commit finish before message_stop', async () => {
  const { stream, events } = await relayAnthropicFrames([
    anthropicFrame('message_start', {
      type: 'message_start', message: { id: 'msg_early_finish', model: 'claude-test' },
    }),
    anthropicFrame('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn' },
    }),
  ]);
  const error = parseSsePayloads(stream).find((payload) => payload.error)?.error;

  assert.equal(error.category, 'truncated');
  assert.doesNotMatch(stream, /"finish_reason":"stop"/);
  assert.equal(events.filter((event) => event.type === 'finish').length, 0);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
});

test('Anthropic adapter rejects message_stop while content blocks remain open', async (t) => {
  const cases = [
    ['text block', [
      anthropicFrame('content_block_start', {
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      }),
    ]],
    ['incomplete tool block', [
      anthropicFrame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_open', name: 'lookup', input: {} },
      }),
      anthropicFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":' },
      }),
    ]],
  ];
  for (const [name, blockFrames] of cases) {
    await t.test(name, async () => {
      const { stream, events } = await relayAnthropicFrames([
        anthropicFrame('message_start', {
          type: 'message_start', message: { id: 'msg_open', model: 'claude-test' },
        }),
        ...blockFrames,
        anthropicFrame('message_delta', {
          type: 'message_delta', delta: { stop_reason: 'end_turn' },
        }),
        anthropicFrame('message_stop', { type: 'message_stop' }),
      ]);
      const error = parseSsePayloads(stream).find((payload) => payload.error)?.error;
      assert.equal(error.category, 'malformed-response');
      assert.equal(error.message, 'The Anthropic provider stream ended with incomplete content blocks.');
      assert.equal(events.filter((event) => event.type === 'finish').length, 0);
      assert.equal(events.filter((event) => event.type === 'error').length, 1);
    });
  }
});

test('Anthropic adapter rejects orphan and cross-type content deltas', async (t) => {
  const deltaCases = [
    ['orphan text', [], { type: 'text_delta', text: 'secret-text' }],
    ['cross-type text', [{ type: 'thinking', thinking: '' }], { type: 'text_delta', text: 'secret-text' }],
    ['orphan thinking', [], { type: 'thinking_delta', thinking: 'secret-thinking' }],
    ['cross-type thinking', [{ type: 'text', text: '' }], { type: 'thinking_delta', thinking: 'secret-thinking' }],
    ['orphan signature', [], { type: 'signature_delta', signature: 'secret-signature' }],
    ['cross-type signature', [{ type: 'text', text: '' }], { type: 'signature_delta', signature: 'secret-signature' }],
  ];
  for (const [name, blocks, delta] of deltaCases) {
    await t.test(name, async () => {
      const starts = blocks.map((contentBlock, index) => anthropicFrame('content_block_start', {
        type: 'content_block_start', index, content_block: contentBlock,
      }));
      const { stream, events } = await relayAnthropicFrames([
        anthropicFrame('message_start', {
          type: 'message_start', message: { id: 'msg_delta', model: 'claude-test' },
        }),
        ...starts,
        anthropicFrame('content_block_delta', {
          type: 'content_block_delta', index: 0, delta,
        }),
      ]);
      const error = parseSsePayloads(stream).find((payload) => payload.error)?.error;
      assert.equal(error.category, 'malformed-response');
      assert.match(error.message, /^The Anthropic provider stream contained an invalid (text|thinking|signature) delta\.$/);
      assert.doesNotMatch(error.message, /secret-/);
      assert.equal(events.filter((event) => event.type === 'error').length, 1);
    });
  }
});

test('Anthropic adapter sanitizes provider-controlled identifiers and event names in diagnostics', async (t) => {
  await t.test('tool identifier', async () => {
    const { stream, events } = await relayAnthropicFrames([
      anthropicFrame('message_start', {
        type: 'message_start', message: { id: 'msg_tool', model: 'claude-test' },
      }),
      anthropicFrame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'sensitive-tool-id', name: 'lookup', input: {} },
      }),
      anthropicFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"broken"' },
      }),
      anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ]);
    const error = parseSsePayloads(stream).find((payload) => payload.error)?.error;
    assert.equal(error.message, 'The Anthropic provider stream contained malformed tool arguments.');
    assert.doesNotMatch(error.message, /sensitive-tool-id/);
    assert.doesNotMatch(events.find((event) => event.type === 'error').error.message, /sensitive-tool-id/);
  });

  await t.test('event name', async () => {
    const { stream, events } = await relayAnthropicFrames([
      anthropicFrame('sensitive-event-name', { type: 'sensitive-event-name' }),
    ]);
    const error = parseSsePayloads(stream).find((payload) => payload.error)?.error;
    assert.equal(error.message, 'The Anthropic provider stream contained an unsupported event.');
    assert.doesNotMatch(error.message, /sensitive-event-name/);
    assert.doesNotMatch(events.find((event) => event.type === 'error').error.message, /sensitive-event-name/);
  });
});

test('Anthropic adapter accepts CRLF multiline data frames', async () => {
  const frame = [
    'event: message_start',
    'data: {"type":"message_start",',
    'data: "message":{"id":"msg_crlf","model":"claude-test"}}',
    '',
    '',
  ].join('\r\n');
  const { stream, events } = await relayAnthropicFrames([
    frame,
    anthropicFrame('message_stop', { type: 'message_stop' }).replaceAll('\n', '\r\n'),
  ]);

  assert.match(stream, /"role":"assistant"/);
  assert.equal(stream.match(/data: \[DONE\]/g)?.length, 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 0);
});

test('Anthropic adapter fails closed on a trailing partial SSE frame', async () => {
  const { stream, events } = await relayAnthropicFrames([
    anthropicFrame('message_start', {
      type: 'message_start', message: { id: 'msg_partial', model: 'claude-test' },
    }),
    'event: content_block_delta\ndata: {"type":"content_block_delta"',
  ]);
  const error = parseSsePayloads(stream).find((payload) => payload.error)?.error;

  assert.equal(error.category, 'truncated');
  assert.equal(error.retryable, true);
  assert.equal(stream.match(/data: \[DONE\]/g)?.length, 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
});

test('Anthropic adapter turns a stalled partial stream into one timeout and aborts upstream', async () => {
  let aborts = 0;
  const provider = http.createServer((req, res) => {
    req.once('aborted', () => { aborts += 1; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(anthropicFrame('message_start', {
      type: 'message_start', message: { id: 'msg_timeout', model: 'claude-test' },
    }));
    res.write(anthropicFrame('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }));
    res.write(anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' },
    }));
  });
  await listen(provider);
  const events = [];
  const router = makeRouter(provider, events, {}, {
    resolve: () => createAnthropicAdapter({ providerIdleTimeoutMs: 40 }),
  });
  await listen(router);
  try {
    const response = await fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'byok-anthropic-claude-test',
        messages: [{ role: 'user', content: 'go' }],
      }),
    });
    const stream = await response.text();
    assert.match(stream, /"content":"partial"/);
    assert.equal(parseSsePayloads(stream).find((payload) => payload.error)?.error.category, 'timeout');
    assert.equal(stream.match(/data: \[DONE\]/g)?.length, 1);
    assert.equal(events.filter((event) => event.type === 'error').length, 1);
    await delay(30);
    assert.equal(aborts, 1);
  } finally {
    await close(router);
    await close(provider);
  }
});

test('Anthropic adapter cancels before provider headers without a terminal diagnostic', async () => {
  let aborts = 0;
  let started;
  const providerStarted = new Promise((resolve) => { started = resolve; });
  const provider = http.createServer((req) => {
    started();
    req.once('aborted', () => { aborts += 1; });
  });
  await listen(provider);
  const events = [];
  const router = makeRouter(provider, events);
  await listen(router);
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'byok-anthropic-claude-test',
      messages: [{ role: 'user', content: 'go' }],
    }),
    signal: controller.signal,
  });
  try {
    await providerStarted;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await delay(50);
    assert.equal(aborts, 1);
    assert.equal(events.filter((event) => event.type === 'error').length, 0);
  } finally {
    await close(router);
    await close(provider);
  }
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
    anthropicFrame('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before' },
    }),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tool_empty', name: 'empty', input: {} },
    }),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'after' },
    }),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 2 }),
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

test('Anthropic adapter preserves thinking, signatures, redactions, identity, and cache-aware usage', async () => {
  const redactedPayload = 'encrypted-redacted-payload';
  const signature = 'signature-bytes';
  const { stream, events } = await relayAnthropicFrames([
    anthropicFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_thinking',
        model: 'claude-provider-model',
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 11,
        },
      },
    }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'First ' },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'then second.' },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature },
    }),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'redacted_thinking', data: redactedPayload },
    }),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '' },
    }),
    anthropicFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'Visible answer' },
    }),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 2 }),
    anthropicFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'pause_turn' },
      usage: { output_tokens: 13 },
    }),
    anthropicFrame('message_stop', { type: 'message_stop' }),
  ]);
  const assembled = assembleAdapterEvents(events);

  assert.equal(assembled.reasoning, 'First then second.');
  assert.equal(assembled.text, 'Visible answer');
  assert.deepEqual(assembled.usage, [
    {
      inputTokens: 5,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 11,
    },
    {
      inputTokens: 5,
      outputTokens: 13,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 11,
      totalTokens: 36,
    },
  ]);
  assert.deepEqual(assembled.metadata.anthropic, [
    { message: { id: 'msg_thinking', model: 'claude-provider-model' } },
    { contentBlock: { index: 0, type: 'thinking' } },
    { contentBlock: { index: 0, type: 'thinking' }, signature },
    {
      contentBlock: { index: 1, type: 'redacted_thinking' },
      redactedThinking: redactedPayload,
    },
    { contentBlock: { index: 2, type: 'text' } },
    { stopReason: 'pause_turn' },
  ]);
  assert.deepEqual(assembled.finishes, ['stop']);
  assert.equal(parseChatChunks(stream)[0].model, 'claude-provider-model');
  assert.match(stream, /"content":"Visible answer"/);
  assert.doesNotMatch(stream, /First |then second|signature-bytes|encrypted-redacted-payload/);
});

test('Anthropic adapter omits missing cache counters from usage snapshots', async () => {
  const { events } = await relayAnthropicFrames([
    anthropicFrame('message_start', {
      type: 'message_start',
      message: { id: 'msg_usage', model: 'claude-test', usage: { input_tokens: 3 } },
    }),
    anthropicFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    }),
    anthropicFrame('message_stop', { type: 'message_stop' }),
  ]);

  assert.deepEqual(assembleAdapterEvents(events).usage, [
    { inputTokens: 3 },
    { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  ]);
});

test('Anthropic adapter does not invent totals for output-only usage', async () => {
  const { events } = await relayAnthropicFrames([
    anthropicFrame('message_start', {
      type: 'message_start',
      message: { id: 'msg_output_only', model: 'claude-test' },
    }),
    anthropicFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    }),
    anthropicFrame('message_stop', { type: 'message_stop' }),
  ]);

  assert.deepEqual(assembleAdapterEvents(events).usage, [{ outputTokens: 2 }]);
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
    const assembled = assembleAdapterEvents(events);
    assert.deepEqual(assembled.finishes, [normalizedReason]);
    assert.deepEqual(assembled.metadata.anthropic.at(-1), { stopReason });
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

function parseSsePayloads(stream) {
  return stream
    .split(/\r?\n/)
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

function makeRouter(provider, events, model = {}, adapters) {
  return createRouter({
    catalog: buildCatalog([{ id: 'anthropic', name: 'Anthropic', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'anthropic-key', adapterKind: 'anthropic', models: [{ model: 'claude-test', ...model }] }]),
    ...(adapters ? { adapters } : {}),
    onEvent: (event) => events.push(event),
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
}

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); }
async function close(server) { await server.shutdown?.(); server.closeAllConnections?.(); if (server.listening) await new Promise((resolve) => server.close(resolve)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
