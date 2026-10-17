import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCatalog, buildModelId, isByokModelId } from '../src/catalog.mjs';
import { selectActiveProviders } from '../src/launcher.mjs';

const provider = {
  id: 'acme',
  name: 'Acme',
  baseUrl: 'https://api.acme.test/v1',
  apiKey: 'secret',
  models: [
    { model: 'acme-large', label: 'Acme Large', contextWindow: 400_000, maxOutputTokens: 64_000 },
    { model: 'acme/small-v2', contextWindow: 32_000, maxOutputTokens: 8_000 },
  ],
};

test('model ids are stable, lowercase, and free of slashes', () => {
  assert.equal(buildModelId('acme', 'acme/small-v2'), 'byok-acme-acme-small-v2');
  assert.equal(buildModelId('acme', 'GLM-5.2'), 'byok-acme-glm-5-2');
  assert.ok(isByokModelId('byok-acme-glm-5-2'));
  assert.ok(!isByokModelId('gpt-5.5'));
});

test('catalog entries declare the capabilities the Copilot harness needs', () => {
  const { entries, routes } = buildCatalog([provider]);

  assert.equal(entries.length, 2);
  const [large] = entries;

  assert.equal(large.name, 'Acme Large');
  assert.equal(large.vendor, 'Acme');
  assert.equal(large.object, 'model');
  assert.equal(large.model_picker_enabled, true);
  assert.equal(large.capabilities.type, 'chat');
  assert.equal(large.capabilities.supports.tool_calls, true);
  assert.equal(large.capabilities.supports.streaming, true);
  assert.equal(large.capabilities.limits.max_context_window_tokens, 400_000);
  assert.equal(large.capabilities.limits.max_output_tokens, 64_000);
  assert.ok(large.capabilities.limits.max_prompt_tokens < 400_000);
  assert.deepEqual(large.supported_endpoints, ['/chat/completions']);

  // The route points back at the provider object, so the router knows where to forward.
  const route = routes.get(large.id);
  assert.equal(route.provider.id, 'acme');
  assert.equal(route.model.model, 'acme-large');
  assert.equal(route.adapterKind, 'openai');
  assert.equal(route.endpointFamily, 'chat-completions');
  assert.equal(route.wireModel, 'acme-large');
  assert.deepEqual(route.authPolicy, { type: 'bearer' });
  assert.equal(route.capabilities, large.capabilities);
  assert.ok(Object.isFrozen(route));
  assert.ok(Object.isFrozen(route.provider));
  assert.ok(Object.isFrozen(route.model));
  assert.ok(Object.isFrozen(route.capabilities));
  assert.ok(Object.isFrozen(route.authPolicy));
});

test('declared route metadata is validated, model-scoped, and immutable', () => {
  const { routes } = buildCatalog([{
    id: 'native', name: 'Native', baseUrl: 'https://native.test/v1', apiKey: 'k',
    adapterKind: 'anthropic', endpointFamily: 'messages', authPolicy: { type: 'x-api-key', header: 'x-api-key' },
    models: [{
      model: 'picker-name', wireModel: 'account/deployment', adapterKind: 'gemini',
      endpointFamily: 'generate-content', authPolicy: { type: 'api-key', query: 'key' },
      providerBaseUrl: 'https://native.test/v1beta',
      routeCapabilities: { modality: 'text', toolCalling: true, reasoning: false },
    }],
  }]);

  const route = routes.get('byok-native-picker-name');
  assert.equal(route.adapterKind, 'gemini');
  assert.equal(route.endpointFamily, 'generate-content');
  assert.equal(route.wireModel, 'account/deployment');
  assert.equal(route.provider.baseUrl, 'https://native.test/v1beta');
  assert.deepEqual(route.authPolicy, { type: 'api-key', query: 'key' });
  assert.deepEqual(route.capabilities, { modality: 'text', toolCalling: true, reasoning: false });
  assert.ok(Object.isFrozen(route.capabilities));
  assert.throws(() => { route.wireModel = 'changed'; }, TypeError);
});

test('invalid route metadata is rejected while building the catalog', () => {
  const base = { id: 'p', name: 'P', baseUrl: 'https://x.test/v1', apiKey: 'k' };
  assert.throws(
    () => buildCatalog([{ ...base, endpointFamily: 'Chat Completions', models: [{ model: 'm' }] }]),
    /endpoint family must be a lowercase identifier/
  );
  assert.throws(
    () => buildCatalog([{ ...base, models: [{ model: 'm', wireModel: ' ' }] }]),
    /requires a non-empty wire model/
  );
  assert.throws(
    () => buildCatalog([{ ...base, authPolicy: { type: 'cookie' }, models: [{ model: 'm' }] }]),
    /auth policy type "cookie" is unsupported/
  );
  assert.throws(
    () => buildCatalog([{ ...base, models: [{ model: 'm', providerBaseUrl: '/v1beta' }] }]),
    /provider base URL must be an absolute HTTP\(S\) URL/
  );
  assert.throws(
    () => buildCatalog([{ ...base, models: [{ model: 'm', routeCapabilities: 'tools' }] }]),
    /capabilities must be an object/
  );
});

test('entries never leak credentials', () => {
  const { entries } = buildCatalog([provider]);
  assert.ok(!JSON.stringify(entries).includes('secret'));
});

test('duplicate route ids are rejected', () => {
  const twin = { ...provider, models: [provider.models[0], provider.models[0]] };
  assert.throws(() => buildCatalog([twin]), /Duplicate route id "byok-acme-acme-large"/);
});

test('only providers with models and credentials are activated', () => {
  const providers = [
    { id: 'ready', models: [{ model: 'a' }], apiKey: 'k' },
    { id: 'no-key', models: [{ model: 'a' }] },
    { id: 'no-models', models: [], apiKey: 'k' },
    { id: 'local', models: [{ model: 'a' }], authRequired: false },
    { id: 'disabled', models: [{ model: 'a' }], apiKey: 'k', enabled: false },
    { id: 'bearer', models: [{ model: 'a' }], bearerToken: 't' },
  ];

  assert.deepEqual(
    selectActiveProviders(providers).map((entry) => entry.id),
    ['ready', 'local', 'bearer']
  );
});

test('prompt and output budgets fit inside the context window', () => {
  const cases = [
    { context: 500_000, output: 500_000 },   // Grok 4.5: output as large as context
    { context: 1_000_000, output: 384_000 }, // DeepSeek V4 Pro
    { context: 200_000, output: 131_072 },   // GLM-5.1
    { context: 128_000, output: 8_000 },     // ordinary case
  ];

  for (const { context, output } of cases) {
    const { entries } = buildCatalog([{
      id: 'p', name: 'P', baseUrl: 'https://x.test/v1', apiKey: 'k',
      models: [{ model: 'm', contextWindow: context, maxOutputTokens: output }],
    }]);

    const limits = entries[0].capabilities.limits;
    assert.ok(
      limits.max_prompt_tokens + limits.max_output_tokens <= limits.max_context_window_tokens,
      `prompt ${limits.max_prompt_tokens} + output ${limits.max_output_tokens} exceeds ${context}`
    );
    assert.ok(limits.max_prompt_tokens > 0);
  }
});

test('the shipped catalog never advertises more than a model can hold', async () => {
  const { readFile } = await import('node:fs/promises');
  const catalog = JSON.parse(await readFile(new URL('../src/providers.default.json', import.meta.url), 'utf8'));

  const providers = catalog.providers
    .filter((provider) => provider.models.length)
    .map((provider) => ({ ...provider, apiKey: 'k' }));

  for (const entry of buildCatalog(providers).entries) {
    const { max_prompt_tokens: prompt, max_output_tokens: output, max_context_window_tokens: context } =
      entry.capabilities.limits;
    assert.ok(prompt + output <= context, `${entry.id}: ${prompt} + ${output} > ${context}`);
  }
});

test('models whose names collide are rejected and reported', () => {
  const events = [];
  assert.throws(() => buildCatalog([{
    id: 'p', name: 'P', baseUrl: 'https://x.test/v1', apiKey: 'k',
    models: [{ model: 'gpt-4.1' }, { model: 'gpt-4-1' }],
  }], (event) => events.push(event)), /Duplicate route id "byok-p-gpt-4-1"/);

  assert.match(events[0].message, /Duplicate route id "byok-p-gpt-4-1"/);
});

test('the effort selector is declared only when explicitly enabled', () => {
  const base = { id: 'p', name: 'P', baseUrl: 'https://x.test/v1', apiKey: 'k' };

  const off = buildCatalog([{ ...base, models: [{ model: 'm', reasoning: true }] }]);
  assert.equal(off.entries[0].capabilities.supports.reasoning_effort, undefined,
    'a selector that changes nothing must not appear');

  const on = buildCatalog([{ ...base, models: [{ model: 'm', reasoning: true, reasoningEffortPicker: true }] }]);
  assert.deepEqual(on.entries[0].capabilities.supports.reasoning_effort, ['low', 'medium', 'high']);

  const custom = buildCatalog([{
    ...base,
    models: [{ model: 'm', reasoning: true, reasoningEffortPicker: true, reasoningEffortLevels: ['low', 'high', 'max'] }],
  }]);
  assert.deepEqual(custom.entries[0].capabilities.supports.reasoning_effort, ['low', 'high', 'max']);
});

test('the provider-level switch applies to its models', () => {
  const { entries } = buildCatalog([{
    id: 'p', name: 'P', baseUrl: 'https://x.test/v1', apiKey: 'k',
    reasoningEffortPicker: true,
    models: [{ model: 'thinker', reasoning: true }, { model: 'plain' }],
  }]);

  assert.ok(entries.find((e) => e.id.endsWith('thinker')).capabilities.supports.reasoning_effort);
  assert.equal(entries.find((e) => e.id.endsWith('plain')).capabilities.supports.reasoning_effort, undefined,
    'a model that does not reason never gets the selector');
});
