import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCatalog } from '../src/catalog.mjs';
import { createRouter } from '../src/router.mjs';
import { createUpstreamResolver } from '../src/upstream.mjs';

const BASE_URL = process.env.COPILOT_BYOK_SDC_GEMINI_BASE_URL;
const TOKEN = process.env.COPILOT_BYOK_SDC_GEMINI_TOKEN;
const MODEL = process.env.COPILOT_BYOK_SDC_GEMINI_MODEL;
const ENABLED = Boolean(BASE_URL && TOKEN && MODEL);

test('live SDC Gemini completes a streaming function-call round trip', { skip: !ENABLED }, async () => {
  const catalog = buildCatalog([{
    id: 'sdc-live-gemini',
    name: 'SDC Gemini live smoke',
    baseUrl: BASE_URL,
    apiKey: TOKEN,
    adapterKind: 'gemini',
    endpointFamily: 'generate-content',
    authPolicy: { type: 'bearer' },
    models: [{ model: 'live-gemini', wireModel: MODEL }],
  }]);
  const router = createRouter({
    catalog,
    upstream: createUpstreamResolver({ explicit: 'https://upstream.invalid' }),
  });
  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));

  try {
    const first = await post(router, {
      model: 'byok-sdc-live-gemini',
      stream: true,
      messages: [{ role: 'user', content: 'Call echo exactly once with value "gemini-smoke".' }],
      tools: [{
        type: 'function',
        function: {
          name: 'echo',
          description: 'Return the supplied value',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'echo' } },
      temperature: 0,
    });
    assert.equal(first.status, 200);
    const firstStream = await first.text();
    const call = assembleToolCall(firstStream);
    assert.equal(call.name, 'echo');
    assert.equal(JSON.parse(call.arguments).value, 'gemini-smoke');

    const second = await post(router, {
      model: 'byok-sdc-live-gemini',
      stream: true,
      messages: [
        { role: 'user', content: 'Call echo exactly once with value "gemini-smoke".' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          }],
        },
        {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ value: 'gemini-smoke' }),
        },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'echo',
          description: 'Return the supplied value',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      }],
      tool_choice: 'none',
      temperature: 0,
    });
    assert.equal(second.status, 200);
    const secondStream = await second.text();
    assert.match(secondStream, /"content":/);
    assert.equal(secondStream.match(/data: \[DONE\]/g)?.length, 1);
  } finally {
    await router.shutdown();
  }
});

function post(router, body) {
  return fetch(`http://127.0.0.1:${router.address().port}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function assembleToolCall(stream) {
  const call = { id: '', name: '', arguments: '' };
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith('data: {')) continue;
    const payload = JSON.parse(line.slice(6));
    for (const fragment of payload.choices?.[0]?.delta?.tool_calls || []) {
      if (fragment.id) call.id += fragment.id;
      if (fragment.function?.name) call.name += fragment.function.name;
      if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
    }
  }
  assert.ok(call.id && call.name && call.arguments, 'live Gemini smoke expected one complete tool call');
  return call;
}
