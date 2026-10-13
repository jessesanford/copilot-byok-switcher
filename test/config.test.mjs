import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findProvider, loadConfig, loadConfigFromPath } from '../src/config.mjs';

test('loads providers from JSON config and resolves apiKeyEnv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [
      {
        name: 'Chutes',
        id: 'chutes',
        type: 'openai',
        baseUrl: 'https://llm.chutes.ai/v1',
        apiKeyEnv: 'TEST_CHUTES_KEY',
        catalogModelId: 'gpt-4.1',
      },
    ],
  }));

  const config = await loadConfigFromPath(configPath, { TEST_CHUTES_KEY: 'secret' });

  assert.equal(config.providers[0].id, 'chutes');
  assert.equal(config.providers[0].apiKey, 'secret');
  assert.equal(config.providers[0].catalogModelId, 'gpt-4.1');
});

test('loads the generated provider catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-empty-config-'));
  const config = await loadConfig({ env: { XDG_CONFIG_HOME: dir } });

  // The catalog is regenerated from models.dev, so the test checks the shape and
  // the fixed points rather than the exact list of models.
  assert.ok(config.providers.length >= 20);

  const openai = findProvider(config, 'openai');
  assert.equal(openai.baseUrl, 'https://api.openai.com/v1');
  assert.ok(openai.apiKeyEnv.includes('OPENAI_API_KEY'));
  assert.ok(openai.models.length > 0);

  const anthropic = findProvider(config, 'anthropic');
  assert.equal(anthropic.baseUrl, 'https://api.anthropic.com/v1');

  const gemini = findProvider(config, 'gemini');
  assert.match(gemini.baseUrl, /generativelanguage\.googleapis\.com/);

  const ollama = findProvider(config, 'ollama');
  assert.equal(ollama.authRequired, false);
  assert.equal(ollama.apiKey, null);

  for (const provider of config.providers) {
    assert.equal(provider.type, 'openai', `${provider.id} must be OpenAI-compatible`);
    for (const model of provider.models) {
      assert.ok(model.model, `${provider.id} has a model without a name`);
      if (model.contextWindow != null) assert.ok(model.contextWindow > 0);
      if (model.maxOutputTokens != null) assert.ok(model.maxOutputTokens > 0);
    }
  }
});

test('every catalog provider exposes a reachable-looking HTTPS or localhost endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-empty-config-'));
  const config = await loadConfig({ env: { XDG_CONFIG_HOME: dir } });

  for (const provider of config.providers) {
    const url = new URL(provider.baseUrl);
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    assert.ok(url.protocol === 'https:' || local, `${provider.id} uses ${url.protocol}`);
  }
});

test('the published example is a valid configuration', async () => {
  const example = await loadConfigFromPath(
    new URL('../examples/providers.example.json', import.meta.url),
    {}
  );

  assert.ok(example.providers.length > 0);
  for (const provider of example.providers) {
    assert.ok(provider.id);
    assert.ok(provider.baseUrl);
    assert.ok(provider.models.length > 0, `${provider.id} must declare at least one model`);
  }

  // The example also covers the credential-free case (local runtime).
  assert.ok(example.providers.some((provider) => provider.authRequired === false));
});

test('rejects inline API keys in provider config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [
      {
        name: 'Unsafe',
        type: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret-on-disk',
      },
    ],
  }));

  await assert.rejects(
    () => loadConfigFromPath(configPath, {}),
    /Inline apiKey is not allowed/
  );
});

test('rejects inline credential fields even when their values are empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      name: 'Unsafe Empty Secret',
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      bearerToken: '',
    }],
  }));

  await assert.rejects(() => loadConfigFromPath(configPath, {}), /Inline bearerToken is not allowed/);
});

test('rejects secret model headers in provider config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [
      {
        name: 'Unsafe Headers',
        type: 'openai',
        baseUrl: 'https://api.example.com/v1',
        modelsHeaders: {
          Authorization: 'Bearer secret-on-disk',
        },
      },
    ],
  }));

  await assert.rejects(
    () => loadConfigFromPath(configPath, {}),
    /Secret model headers are not allowed/
  );
});

test('rejects broader secret headers and credential-like URL query parameters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const headersPath = join(dir, 'headers.json');
  await writeFile(headersPath, JSON.stringify({
    providers: [{
      name: 'Unsafe Cookie',
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      modelsHeaders: { Cookie: 'session=value' },
    }],
  }));
  await assert.rejects(() => loadConfigFromPath(headersPath, {}), /Secret model headers are not allowed/);

  const urlPath = join(dir, 'url.json');
  await writeFile(urlPath, JSON.stringify({
    providers: [{
      name: 'Unsafe URL',
      type: 'openai',
      baseUrl: 'https://api.example.com/v1?api_key=secret',
    }],
  }));
  await assert.rejects(() => loadConfigFromPath(urlPath, {}), /credential-like query parameters/);
});

test('validates provider URLs, types, environment names, and identifiers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'invalid provider',
      name: 'Invalid',
      type: 'unknown',
      baseUrl: 'not-a-url',
      apiKeyEnv: 'NOT VALID',
    }],
  }));

  await assert.rejects(() => loadConfigFromPath(configPath, {}), /Provider id/);
});

test('does not expose invalid credential environment names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'private-provider',
      name: 'Private Provider',
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'SENSITIVE CREDENTIAL SOURCE',
    }],
  }));

  await assert.rejects(
    () => loadConfigFromPath(configPath, {}),
    (error) => {
      assert.match(error.message, /invalid environment variable name/);
      assert.doesNotMatch(error.message, /SENSITIVE CREDENTIAL SOURCE/);
      return true;
    }
  );
});

test('rejects ambiguous provider identifiers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [
      { id: 'one', aliases: ['shared'], name: 'One', type: 'openai', baseUrl: 'https://one.example.com' },
      { id: 'two', aliases: ['shared'], name: 'Two', type: 'openai', baseUrl: 'https://two.example.com' },
    ],
  }));

  await assert.rejects(() => loadConfigFromPath(configPath, {}), /used by both One and Two/);
});

test('rejects duplicate ids even when providers have the same display name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [
      { id: 'duplicate', name: 'Same', type: 'openai', baseUrl: 'https://one.example.com' },
      { id: 'duplicate', name: 'Same', type: 'openai', baseUrl: 'https://two.example.com' },
    ],
  }));

  await assert.rejects(() => loadConfigFromPath(configPath, {}), /used by both Same and Same/);
});

test('validates wire API values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'invalid-wire-api',
      name: 'Invalid Wire API',
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      wireApi: 'legacy',
    }],
  }));

  await assert.rejects(() => loadConfigFromPath(configPath, {}), /completions.*responses/);
});

test('normalizes additive transport, Azure, auth, and model filter options', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'extended',
      name: 'Extended',
      type: 'azure',
      baseUrl: 'https://example.openai.azure.com',
      authRequired: false,
      modelsAuth: 'api-key',
      transport: 'websockets',
      adapterKind: 'Gemini-Native',
      azureApiVersion: '2025-04-01-preview',
      modelIncludePrefixes: [' chat- '],
      modelExcludePrefixes: ['chat-legacy'],
    }],
  }));

  const provider = (await loadConfigFromPath(configPath, {})).providers[0];
  assert.equal(provider.authRequired, false);
  assert.equal(provider.modelsAuth, 'api-key');
  assert.equal(provider.transport, 'websockets');
  assert.equal(provider.adapterKind, 'gemini-native');
  assert.equal(provider.azureApiVersion, '2025-04-01-preview');
  assert.deepEqual(provider.modelIncludePrefixes, ['chat-']);
  assert.deepEqual(provider.modelExcludePrefixes, ['chat-legacy']);
});

test('rejects invalid additive provider option values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'invalid-options',
      name: 'Invalid Options',
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      authRequired: 'sometimes',
      modelsAuth: 'cookie',
      transport: 'stdio',
      modelIncludePrefixes: [],
    }],
  }));

  await assert.rejects(() => loadConfigFromPath(configPath, {}), /modelIncludePrefixes|transport|authRequired|modelsAuth/);
});

test('rejects invalid adapter kinds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'invalid-adapter',
      name: 'Invalid Adapter',
      baseUrl: 'https://api.example.com/v1',
      adapterKind: 'openai/native',
    }],
  }));

  await assert.rejects(() => loadConfigFromPath(configPath, {}), /adapterKind must be a lowercase identifier/);
});

test('rejects an OpenAI wire API override on Anthropic providers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'anthropic-wire-api',
      name: 'Anthropic Wire API',
      type: 'anthropic',
      baseUrl: 'https://api.example.com',
      wireApi: 'responses',
    }],
  }));

  await assert.rejects(() => loadConfigFromPath(configPath, {}), /Anthropic protocol/);
});

test('adds the config path to malformed JSON errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, '{broken');

  await assert.rejects(() => loadConfigFromPath(configPath, {}), new RegExp(configPath.replaceAll('\\', '\\\\')));
});

test('a single-string apiKeyEnv is normalized to an array', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-scalar-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'acme',
      name: 'Acme',
      baseUrl: 'https://api.acme.test/v1',
      apiKeyEnv: 'ACME_KEY',
      bearerTokenEnv: 'ACME_TOKEN',
      models: [{ model: 'm' }],
    }],
  }));

  const config = await loadConfigFromPath(configPath, { ACME_KEY: 'secret' });
  const [provider] = config.providers;

  // Every consumer iterates over these; a bare string used to crash them.
  assert.deepEqual(provider.apiKeyEnv, ['ACME_KEY']);
  assert.deepEqual(provider.bearerTokenEnv, ['ACME_TOKEN']);
  assert.equal(provider.apiKey, 'secret');
});

test('inline secrets are rejected in request headers, not just catalog headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-headers-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'gw',
      name: 'Gateway',
      baseUrl: 'https://gw.test/v1',
      headers: { Authorization: 'Bearer sk-inline-secret' },
      models: [{ model: 'm' }],
    }],
  }));

  await assert.rejects(() => loadConfigFromPath(configPath, {}), /Secret request headers are not allowed/);
});

test('non-secret gateway headers are still allowed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-byok-headers-ok-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    providers: [{
      id: 'gw',
      name: 'Gateway',
      baseUrl: 'https://gw.test/v1',
      headers: { 'X-Tenant-Id': 'platform-team' },
      models: [{ model: 'm' }],
    }],
  }));

  const config = await loadConfigFromPath(configPath, {});
  assert.equal(config.providers[0].headers['X-Tenant-Id'], 'platform-team');
});
