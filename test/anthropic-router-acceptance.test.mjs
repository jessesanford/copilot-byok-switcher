import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { assembleAdapterEvents } from '../src/adapters/events.mjs';
import { buildCatalog } from '../src/catalog.mjs';
import { createRouter } from '../src/router.mjs';
import { createUpstreamResolver } from '../src/upstream.mjs';

const API_KEY = 'anthropic-acceptance-secret';
const PICKER_MODEL = 'byok-sdc-claude-acceptance';
const WIRE_MODEL = 'claude-wire-acceptance';

test('Anthropic router acceptance: text uses the declared route, wire model, auth, and complete request', async () => {
  let received;
  const harness = await startHarness((req, res, body) => {
    received = { path: req.url, headers: req.headers, body };
    sendFrames(res, [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_text', model: WIRE_MODEL, usage: { input_tokens: 4 } },
      }),
      frame('content_block_start', {
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'router' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ]);
  });

  try {
    const request = {
      model: PICKER_MODEL,
      stream: true,
      max_tokens: 64,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Say hello.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a value',
          parameters: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: 'auto',
    };
    const response = await post(harness, request);
    const stream = await response.text();

    assert.equal(response.status, 200);
    assert.equal(received.path, '/v1/messages');
    assert.equal(received.headers['x-api-key'], API_KEY);
    assert.equal(received.headers.authorization, undefined);
    assert.deepEqual(received.body, {
      model: WIRE_MODEL,
      system: [{ type: 'text', text: 'Be brief.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }],
      max_tokens: 64,
      stream: true,
      tools: [{
        name: 'lookup',
        description: 'Look up a value',
        input_schema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
      }],
      tool_choice: { type: 'auto' },
    });
    assert.match(stream, /"content":"Hello "/);
    assert.match(stream, /"content":"router"/);
    assert.match(stream, /"finish_reason":"stop"/);
    assert.equal(doneCount(stream), 1);
    assert.deepEqual(harness.events.find(({ type }) => type === 'route'), {
      type: 'route', provider: 'sdc', model: 'claude-acceptance', adapter: 'anthropic',
    });
    const assembled = assembleAdapterEvents(harness.events.filter(isAdapterEvent));
    assert.equal(assembled.text, 'Hello router');
    assert.deepEqual(assembled.usage.at(-1), {
      inputTokens: 4, outputTokens: 2, totalTokens: 6,
    });
  } finally {
    await harness.close();
  }
});

test('Anthropic router acceptance: rich streams preserve parallel tools, hidden thinking metadata, and usage', async () => {
  const signature = 'hidden-signature';
  const redacted = 'hidden-redacted-thinking';
  const harness = await startHarness((_req, res) => {
    sendFrames(res, [
      frame('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_rich',
          model: WIRE_MODEL,
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 11,
          },
        },
      }),
      frame('content_block_start', {
        type: 'content_block_start', index: 3, content_block: { type: 'thinking', thinking: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta', index: 3, delta: { type: 'thinking_delta', thinking: 'private thought' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta', index: 3, delta: { type: 'signature_delta', signature },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 3 }),
      frame('content_block_start', {
        type: 'content_block_start', index: 4, content_block: { type: 'redacted_thinking', data: redacted },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 4 }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tool_b', name: 'second', input: {} },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_a', name: 'first', input: {} },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"n":' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'Paris"}' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 2 }),
      frame('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 13 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ]);
  });

  try {
    const response = await post(harness, {
      model: PICKER_MODEL,
      messages: [{ role: 'user', content: 'Use both tools.' }],
      tools: [
        { type: 'function', function: { name: 'first', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'second', parameters: { type: 'object' } } },
      ],
    });
    const stream = await response.text();
    const assembled = assembleAdapterEvents(harness.events.filter(isAdapterEvent));

    assert.equal(response.status, 200);
    assert.deepEqual(assembled.tools, [
      { id: 'tool_a', index: 0, name: 'first', arguments: '{"n":1}', complete: true },
      { id: 'tool_b', index: 2, name: 'second', arguments: '{"city":"Paris"}', complete: true },
    ]);
    assert.deepEqual(assembled.finishes, ['tool-calls']);
    assert.equal(assembled.reasoning, 'private thought');
    assert.deepEqual(assembled.usage.at(-1), {
      inputTokens: 5,
      outputTokens: 13,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 11,
      totalTokens: 36,
    });
    assert.deepEqual(assembled.metadata.anthropic, [
      { message: { id: 'msg_rich', model: WIRE_MODEL } },
      { contentBlock: { index: 3, type: 'thinking' } },
      { contentBlock: { index: 3, type: 'thinking' }, signature },
      { contentBlock: { index: 4, type: 'redacted_thinking' }, redactedThinking: redacted },
      { contentBlock: { index: 2, type: 'tool_use' } },
      { contentBlock: { index: 0, type: 'tool_use' } },
      { stopReason: 'tool_use' },
    ]);
    assert.deepEqual(clientToolFragments(stream), [
      {
        index: 2,
        id: 'tool_b',
        type: 'function',
        function: { name: 'second', arguments: '' },
      },
      { index: 2, function: { arguments: '{"city":"' } },
      {
        index: 0,
        id: 'tool_a',
        type: 'function',
        function: { name: 'first', arguments: '' },
      },
      { index: 0, function: { arguments: '{"n":' } },
      { index: 2, function: { arguments: 'Paris"}' } },
      { index: 0, function: { arguments: '1}' } },
    ]);
    assert.deepEqual(assembleClientToolCalls(stream), [
      { index: 0, id: 'tool_a', name: 'first', arguments: '{"n":1}' },
      { index: 2, id: 'tool_b', name: 'second', arguments: '{"city":"Paris"}' },
    ]);
    assert.match(stream, /"finish_reason":"tool_calls"/);
    assert.equal(doneCount(stream), 1);
    assert.doesNotMatch(stream, /private thought|hidden-signature|hidden-redacted-thinking/);
  } finally {
    await harness.close();
  }
});

test('Anthropic router acceptance: HTTP and post-partial SSE failures are safe and terminal exactly once', async (t) => {
  await t.test('HTTP failure', async () => {
    const harness = await startHarness((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `do not leak ${API_KEY}` } }));
    });
    try {
      const response = await post(harness, {
        model: PICKER_MODEL, messages: [{ role: 'user', content: 'Fail.' }],
      });
      const body = await response.text();
      assert.equal(response.status, 429);
      assert.deepEqual(JSON.parse(body).error, {
        category: 'rate-limit',
        message: 'The Anthropic provider rate limit was exceeded.',
        retryable: true,
        status: 429,
      });
      assert.doesNotMatch(body, new RegExp(API_KEY));
      assert.equal(harness.events.filter(({ type }) => type === 'error').length, 1);
    } finally {
      await harness.close();
    }
  });

  await t.test('SSE failure after partial output', async () => {
    const harness = await startHarness((_req, res) => {
      sendFrames(res, [
        frame('message_start', {
          type: 'message_start', message: { id: 'msg_failure', model: WIRE_MODEL },
        }),
        frame('content_block_start', {
          type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
        }),
        frame('content_block_delta', {
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' },
        }),
        frame('error', {
          type: 'error', error: { type: 'overloaded_error', message: `do not leak ${API_KEY}` },
        }),
        frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        frame('message_stop', { type: 'message_stop' }),
      ]);
    });
    try {
      const response = await post(harness, {
        model: PICKER_MODEL, messages: [{ role: 'user', content: 'Fail later.' }],
      });
      const stream = await response.text();
      const errors = harness.events.filter(({ type }) => type === 'error');
      const downstreamErrors = parsePayloads(stream)
        .filter((payload) => payload.error)
        .map((payload) => payload.error);
      assert.match(stream, /"content":"partial"/);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].error.category, 'upstream');
      assert.deepEqual(downstreamErrors, [{
        category: 'upstream',
        message: 'The Anthropic provider stream failed.',
        retryable: true,
      }]);
      const finishReasons = parsePayloads(stream)
        .flatMap((payload) => payload.choices || [])
        .map((choice) => choice.finish_reason)
        .filter(Boolean);
      assert.deepEqual(finishReasons, []);
      assert.doesNotMatch(stream, new RegExp(API_KEY));
      assert.equal(doneCount(stream), 1);
      await delay(50);
      assert.equal(harness.events.filter(({ type }) => type === 'error').length, 1);
    } finally {
      await harness.close();
    }
  });
});

test('Anthropic router acceptance: client cancellation aborts upstream once without a late terminal event', async () => {
  let aborts = 0;
  let providerStarted;
  const providerReady = new Promise((resolve) => { providerStarted = resolve; });
  const harness = await startHarness((req, res) => {
    providerStarted();
    res.once('close', () => { aborts += 1; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame('message_start', {
      type: 'message_start', message: { id: 'msg_cancel', model: WIRE_MODEL },
    }));
  });
  let downstream;
  let downstreamStarted;
  const downstreamReady = new Promise((resolve) => { downstreamStarted = resolve; });
  const request = http.request({
    hostname: '127.0.0.1',
    port: harness.router.address().port,
    path: '/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (response) => {
    downstream = response;
    downstreamStarted();
  });
  request.on('error', () => {});
  request.end(JSON.stringify({
    model: PICKER_MODEL, messages: [{ role: 'user', content: 'Cancel.' }],
  }));

  try {
    await Promise.race([
      providerReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error('provider did not start')), 500)),
    ]);
    await Promise.race([
      downstreamReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error('downstream stream did not start')), 500)),
    ]);
    downstream.destroy();
    await delay(100);
    assert.equal(aborts, 1);
    assert.equal(harness.events.filter(({ type }) => type === 'error').length, 0);
    assert.equal(harness.events.filter(({ type }) => type === 'finish').length, 0);
  } finally {
    downstream?.destroy();
    request.destroy();
    await harness.close();
  }
});

async function startHarness(handleProviderRequest) {
  const events = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    handleProviderRequest(req, res, body);
  });
  await listen(provider);
  const catalog = buildCatalog([{
    id: 'sdc',
    name: 'Siemens SDC',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiKey: API_KEY,
    adapterKind: 'anthropic',
    authPolicy: { type: 'x-api-key', header: 'x-api-key' },
    models: [{ model: 'claude-acceptance', wireModel: WIRE_MODEL }],
  }]);
  const router = createRouter({
    catalog,
    onEvent: (event) => events.push(event),
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await listen(router);
  return {
    events,
    router,
    async close() {
      await router.shutdown();
      provider.closeAllConnections();
      await close(provider);
    },
  };
}

function post(harness, body) {
  return fetch(`http://127.0.0.1:${harness.router.address().port}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sendFrames(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const value of frames) res.write(value);
  res.end();
}

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function doneCount(stream) {
  return stream.match(/data: \[DONE\]/g)?.length || 0;
}

function parsePayloads(stream) {
  return stream.split(/\r?\n/)
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
}

function clientToolFragments(stream) {
  return parsePayloads(stream)
    .flatMap((payload) => payload.choices || [])
    .flatMap((choice) => choice.delta?.tool_calls || []);
}

function assembleClientToolCalls(stream) {
  const calls = new Map();
  for (const fragment of clientToolFragments(stream)) {
    const call = calls.get(fragment.index) || {
      index: fragment.index,
      id: '',
      name: '',
      arguments: '',
    };
    if (fragment.id) call.id = fragment.id;
    if (fragment.function?.name) call.name += fragment.function.name;
    if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
    calls.set(fragment.index, call);
  }
  return [...calls.values()].sort((left, right) => left.index - right.index);
}

function isAdapterEvent(event) {
  return ['text', 'reasoning', 'tool-fragment', 'tool', 'usage', 'finish', 'metadata', 'error']
    .includes(event.type);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
