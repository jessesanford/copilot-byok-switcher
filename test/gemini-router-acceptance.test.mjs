import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { assembleAdapterEvents } from '../src/adapters/events.mjs';
import { buildCatalog } from '../src/catalog.mjs';
import { createRouter } from '../src/router.mjs';
import { createUpstreamResolver } from '../src/upstream.mjs';

test('Gemini router acceptance uses the declared route, wire model, auth, and request', async () => {
  let received;
  const harness = await startHarness(async (req, res) => {
    received = {
      path: req.url,
      authorization: req.headers.authorization,
      body: await readJson(req),
    };
    sendFrames(res, [
      {
        candidates: [{ index: 0, content: { parts: [{ text: 'routed' }] }, finishReason: 'STOP' }],
      },
    ]);
  });

  try {
    const response = await post(harness, basicRequest('route me'));
    const stream = await response.text();

    assert.equal(response.status, 200);
    assert.equal(
      received.path,
      '/v1beta/models/publishers%2Fgoogle%2Fmodels%2Fgemini-acceptance:streamGenerateContent?alt=sse',
    );
    assert.equal(received.authorization, ['Bearer', API_KEY].join(' '));
    assert.deepEqual(received.body, {
      contents: [{ role: 'user', parts: [{ text: 'route me' }] }],
    });
    assert.deepEqual(harness.events.find(({ type }) => type === 'route'), {
      type: 'route', provider: 'sdc', model: 'gemini-acceptance', adapter: 'gemini',
    });
    assert.equal(assemble(harness.events).text, 'routed');
    assert.equal(doneCount(stream), 1);
    assert.ok(parsePayloads(stream).every(({ id, model }) => (
      typeof id === 'string'
      && id.startsWith('gemini-')
      && model === 'publishers/google/models/gemini-acceptance'
    )));
  } finally {
    await harness.close();
  }
});

test('Gemini router acceptance preserves rich tools, thoughts, safety metadata, and usage', async () => {
  let received;
  const signature = 'router-hidden-signature';
  const harness = await startHarness(async (req, res) => {
    received = await readJson(req);
    sendFrames(res, [{
      candidates: [{
        index: 0,
        content: {
          parts: [
            { thought: true, text: 'private router thought', thoughtSignature: signature },
            { text: 'Using tools.' },
            { functionCall: { name: 'first', args: { n: 1 } } },
            { functionCall: { name: 'second', args: { city: 'Paris' } } },
          ],
        },
        safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' }],
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 7,
        totalTokenCount: 14,
        thoughtsTokenCount: 2,
      },
    }]);
  });

  try {
    const response = await post(harness, {
      model: PICKER_MODEL,
      stream: true,
      messages: [
        { role: 'system', content: 'Use both tools.' },
        { role: 'user', content: 'Run them.' },
      ],
      tools: [
        { type: 'function', function: { name: 'first', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'second', parameters: { type: 'object' } } },
      ],
      tool_choice: 'required',
    });
    const stream = await response.text();
    const assembled = assemble(harness.events);

    assert.equal(response.status, 200);
    assert.deepEqual(received, {
      systemInstruction: { parts: [{ text: 'Use both tools.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Run them.' }] }],
      tools: [{
        functionDeclarations: [
          { name: 'first', parameters: { type: 'object' } },
          { name: 'second', parameters: { type: 'object' } },
        ],
      }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    });
    assert.equal(assembled.text, 'Using tools.');
    assert.equal(assembled.reasoning, 'private router thought');
    assert.deepEqual(assembled.tools.map((tool) => ({
      name: tool.name,
      arguments: tool.arguments,
    })), [
      { name: 'first', arguments: '{"n":1}' },
      { name: 'second', arguments: '{"city":"Paris"}' },
    ]);
    assert.deepEqual(assembled.usage, [{
      inputTokens: 5, outputTokens: 7, totalTokens: 14, reasoningTokens: 2,
    }]);
    assert.deepEqual(assembled.finishes, ['tool-calls']);
    assert.doesNotMatch(stream, /private router thought|router-hidden-signature/);
    assert.match(stream, /"finish_reason":"tool_calls"/);
    assert.equal(doneCount(stream), 1);
  } finally {
    await harness.close();
  }
});

test('Gemini router acceptance returns safe typed safety and native stream failures', async (t) => {
  await t.test('prompt safety block', async () => {
    const harness = await startHarness((_req, res) => {
      sendFrames(res, [{
        promptFeedback: {
          blockReason: 'SAFETY',
          safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }],
        },
      }]);
    });
    try {
      const response = await post(harness, basicRequest('Blocked.'));
      const stream = await response.text();
      assert.equal(response.status, 200);
      assert.equal(harness.events.filter(({ type }) => type === 'error').length, 1);
      assert.match(stream, /"category":"upstream"/);
      assert.equal(doneCount(stream), 1);
    } finally {
      await harness.close();
    }
  });

  await t.test('native error after partial output', async () => {
    const harness = await startHarness((_req, res) => {
      sendFrames(res, [
        { candidates: [{ index: 0, content: { parts: [{ text: 'partial' }] } }] },
        { error: { code: 503, status: 'UNAVAILABLE', message: 'provider-private-detail' } },
      ]);
    });
    try {
      const response = await post(harness, basicRequest('Fail.'));
      const stream = await response.text();
      assert.match(stream, /"content":"partial"/);
      assert.match(stream, /"category":"upstream"/);
      assert.doesNotMatch(stream, /provider-private-detail/);
      assert.equal(harness.events.filter(({ type }) => type === 'finish').length, 0);
      assert.equal(harness.events.filter(({ type }) => type === 'error').length, 1);
      assert.equal(doneCount(stream), 1);
    } finally {
      await harness.close();
    }
  });
});

test('Gemini router acceptance aborts upstream on client cancellation without a late terminal event', async () => {
  let closes = 0;
  let providerStarted;
  const providerReady = new Promise((resolve) => { providerStarted = resolve; });
  const harness = await startHarness((_req, res) => {
    providerStarted();
    res.once('close', () => { closes += 1; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(geminiFrame({
      candidates: [{ index: 0, content: { parts: [{ text: 'partial' }] } }],
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
  request.end(JSON.stringify(basicRequest('Cancel.')));

  try {
    await Promise.all([
      settleWithin(providerReady, 500, 'provider did not start'),
      settleWithin(downstreamReady, 500, 'downstream did not start'),
    ]);
    downstream.destroy();
    await delay(100);
    assert.equal(closes, 1);
    assert.equal(harness.events.filter(({ type }) => ['finish', 'error'].includes(type)).length, 0);
  } finally {
    downstream?.destroy();
    request.destroy();
    await harness.close();
  }
});

const API_KEY = 'acceptance-secret';
const PICKER_MODEL = 'byok-sdc-gemini-acceptance';

async function startHarness(handleRequest) {
  const events = [];
  const provider = http.createServer(handleRequest);
  await listen(provider);
  const catalog = buildCatalog([{
    id: 'sdc',
    name: 'Siemens SDC',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1beta`,
    apiKey: API_KEY,
    adapterKind: 'gemini',
    endpointFamily: 'generate-content',
    authPolicy: { type: 'bearer' },
    models: [{
      model: 'gemini-acceptance',
      wireModel: 'publishers/google/models/gemini-acceptance',
    }],
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

function basicRequest(content) {
  return {
    model: PICKER_MODEL,
    stream: true,
    messages: [{ role: 'user', content }],
  };
}

function sendFrames(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const value of frames) res.write(geminiFrame(value));
  res.end();
}

function geminiFrame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function parsePayloads(stream) {
  return stream.split(/\r?\n/)
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
}

function doneCount(stream) {
  return stream.match(/data: \[DONE\]/g)?.length || 0;
}

function assemble(events) {
  return assembleAdapterEvents(events.filter(({ type }) => [
    'text', 'reasoning', 'tool-fragment', 'tool', 'usage', 'finish', 'metadata', 'error',
  ].includes(type)));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settleWithin(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
