import { access, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROVIDER_TYPES = new Set(['openai', 'anthropic', 'azure']);
const WIRE_APIS = new Set(['completions', 'responses']);
const TRANSPORTS = new Set(['http', 'websockets']);
const ADAPTER_KIND_PATTERN = /^[a-z][a-z0-9-]*$/;
const MODELS_AUTH_MODES = new Set([true, false, 'none', 'bearer', 'x-api-key', 'api-key']);
const SECRET_QUERY_NAME_PATTERN = /(^|[-_.])(api[-_.]?key|subscription[-_.]?key|auth(?:orization)?|bearer|credential|password|secret|signature|sig|token)([-_.]|$)/i;

// Default catalog: generated from models.dev with `npm run catalog:update`, so
// context windows and capabilities stay aligned with what providers actually offer.
const DEFAULT_PROVIDERS = JSON.parse(
  readFileSync(new URL('./providers.default.json', import.meta.url), 'utf8')
).providers;

export async function loadConfig({ configPath, env = process.env, secrets = {} } = {}) {
  const explicitPath = configPath || env.COPILOT_BYOK_CONFIG;
  if (explicitPath) return loadConfigFromPath(explicitPath, env, secrets);

  const defaultPath = defaultConfigPath(env);
  if (await fileExists(defaultPath)) return loadConfigFromPath(defaultPath, env, secrets);

  return normalizeConfig({ providers: DEFAULT_PROVIDERS }, env, secrets);
}

export async function loadConfigFromPath(configPath, env = process.env, secrets = {}) {
  const contents = await readFile(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in provider config ${configPath}: ${error.message}`, { cause: error });
  }

  return normalizeConfig(parsed, env, secrets);
}

export function findProvider(config, requested) {
  if (!requested) return null;
  const normalized = requested.toLowerCase();
  return config.providers.find((provider) => {
    const ids = [provider.id, provider.name, ...(provider.aliases || [])]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return ids.includes(normalized);
  }) || null;
}

function normalizeConfig(config, env, secrets = {}) {
  if (!isRecord(config) || !Array.isArray(config.providers)) {
    throw new Error('Provider config must be an object with a providers array');
  }

  const providers = config.providers.map((provider, index) => normalizeProvider(provider, env, index, secrets));
  assertUniqueProviderNames(providers);

  return { ...config, providers };
}

function normalizeProvider(provider, env, index, secrets = {}) {
  if (!isRecord(provider)) {
    throw new Error(`Provider at index ${index} must be an object`);
  }

  const name = requiredString(provider.name, `Provider at index ${index} requires a name`);
  const id = provider.id == null ? slug(name) : requiredString(provider.id, `Provider ${name} requires an id`);
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(`Provider id "${id}" may contain only letters, numbers, dots, underscores, and hyphens`);
  }

  // Catalog providers are OpenAI-compatible: `type` only matters to the legacy
  // mode (COPILOT_PROVIDER_*), where it distinguishes anthropic and azure.
  const type = provider.type == null
    ? 'openai'
    : requiredString(provider.type, `Provider ${name} requires a type`).toLowerCase();
  if (!PROVIDER_TYPES.has(type)) {
    throw new Error(`Provider ${name} has unsupported type "${provider.type}"`);
  }

  const aliases = normalizeAliases(provider.aliases, name);
  const baseUrl = validateHttpUrl(provider.baseUrl, `Provider ${name} baseUrl`);
  const modelsUrl = provider.modelsUrl == null
    ? undefined
    : validateHttpUrl(provider.modelsUrl, `Provider ${name} modelsUrl`);
  const apiKeyEnv = normalizeEnvNames(provider.apiKeyEnv, name, 'apiKeyEnv');
  const bearerTokenEnv = normalizeEnvNames(provider.bearerTokenEnv, name, 'bearerTokenEnv');
  const wireApi = provider.wireApi == null
    ? undefined
    : requiredString(provider.wireApi, `Provider ${name} wireApi must be a non-empty string`).toLowerCase();
  const transport = provider.transport == null
    ? undefined
    : requiredString(provider.transport, `Provider ${name} transport must be a non-empty string`).toLowerCase();
  const adapterKind = normalizeAdapterKind(provider.adapterKind ?? (type === 'anthropic' ? 'anthropic' : undefined), `Provider ${name}`);
  const azureApiVersion = provider.azureApiVersion == null
    ? undefined
    : requiredString(provider.azureApiVersion, `Provider ${name} azureApiVersion must be a non-empty string`);
  const modelIncludePrefixes = normalizeStringList(provider.modelIncludePrefixes, name, 'modelIncludePrefixes');
  const modelExcludePrefixes = normalizeStringList(provider.modelExcludePrefixes, name, 'modelExcludePrefixes');

  if (Object.hasOwn(provider, 'apiKey')) {
    throw new Error(`Inline apiKey is not allowed for provider ${name}. Use apiKeyEnv instead.`);
  }

  if (Object.hasOwn(provider, 'bearerToken')) {
    throw new Error(`Inline bearerToken is not allowed for provider ${name}. Use bearerTokenEnv instead.`);
  }

  validateProviderOptions(provider, name, type);
  rejectSecretModelHeaders(provider, name);

  const models = normalizeModels(provider.models, name);

  return {
    ...provider,
    id,
    name,
    type,
    baseUrl,
    models,
    ...(modelsUrl ? { modelsUrl } : {}),
    ...(aliases ? { aliases } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(bearerTokenEnv ? { bearerTokenEnv } : {}),
    ...(wireApi ? { wireApi } : {}),
    ...(transport ? { transport } : {}),
    ...(adapterKind ? { adapterKind } : {}),
    ...(azureApiVersion ? { azureApiVersion } : {}),
    ...(modelIncludePrefixes ? { modelIncludePrefixes } : {}),
    ...(modelExcludePrefixes ? { modelExcludePrefixes } : {}),
    // The environment wins over the optional key store, so a shell variable can
    // always override a stored key for one session.
    apiKey: readFirstEnv(env, apiKeyEnv) ?? secrets[id] ?? null,
    bearerToken: readFirstEnv(env, bearerTokenEnv),
  };
}

/** Models published to the Copilot picker. Absent => the provider is legacy-only. */
function normalizeModels(value, providerName) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Provider ${providerName} models must be an array`);
  }

  return value.map((entry, index) => {
    const where = `Provider ${providerName} models[${index}]`;
    if (typeof entry === 'string') return { model: requiredString(entry, `${where} must be a non-empty string`) };
    if (!isRecord(entry)) throw new Error(`${where} must be a string or an object`);

    const model = requiredString(entry.model, `${where} requires a model name`);
    if (entry.reasoningEffort != null) validateEffort(entry.reasoningEffort, where);
    if (entry.reasoningEffortLevels != null) {
      if (!Array.isArray(entry.reasoningEffortLevels) || entry.reasoningEffortLevels.length === 0) {
        throw new Error(`${where} reasoningEffortLevels must be a non-empty array`);
      }
      entry.reasoningEffortLevels.forEach((level) => validateEffort(level, where));
    }
    for (const field of ['contextWindow', 'maxOutputTokens']) {
      if (entry[field] != null && (!Number.isInteger(entry[field]) || entry[field] <= 0)) {
        throw new Error(`${where} ${field} must be a positive integer`);
      }
    }
    if (entry.label != null) requiredString(entry.label, `${where} label must be a non-empty string`);
    const adapterKind = normalizeAdapterKind(entry.adapterKind, where);

    return { ...entry, model, ...(adapterKind ? { adapterKind } : {}) };
  });
}

function normalizeAdapterKind(value, where) {
  if (value == null) return undefined;
  const kind = requiredString(value, `${where} adapterKind must be a non-empty string`).toLowerCase();
  if (!ADAPTER_KIND_PATTERN.test(kind)) {
    throw new Error(`${where} adapterKind must be a lowercase identifier containing only letters, numbers, and hyphens`);
  }
  return kind;
}

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** The levels Copilot itself accepts; passed through to the provider verbatim. */
function validateEffort(value, where) {
  const effort = requiredString(value, `${where} reasoningEffort must be a non-empty string`).toLowerCase();
  if (!REASONING_EFFORTS.has(effort)) {
    throw new Error(`${where} reasoningEffort must be one of: ${[...REASONING_EFFORTS].join(', ')}`);
  }
  return effort;
}

function validateProviderOptions(provider, name, type) {
  if (provider.reasoningEffort != null) validateEffort(provider.reasoningEffort, `Provider ${name}`);
  for (const field of ['catalogModelId', 'defaultModel']) {
    if (provider[field] != null) requiredString(provider[field], `Provider ${name} ${field} must be a non-empty string`);
  }

  if (provider.wireApi != null) {
    const wireApi = requiredString(provider.wireApi, `Provider ${name} wireApi must be a non-empty string`).toLowerCase();
    if (!WIRE_APIS.has(wireApi)) {
      throw new Error(`Provider ${name} wireApi must be "completions" or "responses"`);
    }
    if (type === 'anthropic') {
      throw new Error(`Provider ${name} cannot set wireApi for the Anthropic protocol`);
    }
  }

  if (provider.transport != null) {
    const transport = requiredString(provider.transport, `Provider ${name} transport must be a non-empty string`).toLowerCase();
    if (!TRANSPORTS.has(transport)) {
      throw new Error(`Provider ${name} transport must be "http" or "websockets"`);
    }
  }

  if (provider.azureApiVersion != null) {
    requiredString(provider.azureApiVersion, `Provider ${name} azureApiVersion must be a non-empty string`);
  }

  for (const field of ['maxPromptTokens', 'maxOutputTokens']) {
    if (provider[field] != null && (!Number.isInteger(provider[field]) || provider[field] <= 0)) {
      throw new Error(`Provider ${name} ${field} must be a positive integer`);
    }
  }

  if (provider.modelsTimeoutMs != null && (
    !Number.isInteger(provider.modelsTimeoutMs) ||
    provider.modelsTimeoutMs < 10 ||
    provider.modelsTimeoutMs > 300_000
  )) {
    throw new Error(`Provider ${name} modelsTimeoutMs must be an integer between 10 and 300000`);
  }

  if (provider.requireToolSupport != null && typeof provider.requireToolSupport !== 'boolean') {
    throw new Error(`Provider ${name} requireToolSupport must be a boolean`);
  }

  if (provider.authRequired != null && typeof provider.authRequired !== 'boolean') {
    throw new Error(`Provider ${name} authRequired must be a boolean`);
  }

  if (provider.modelsAuth != null && !MODELS_AUTH_MODES.has(provider.modelsAuth)) {
    throw new Error(`Provider ${name} modelsAuth must be true, false, "none", "bearer", "x-api-key", or "api-key"`);
  }

  if (provider.modelsHeaders != null) {
    if (!isRecord(provider.modelsHeaders)) {
      throw new Error(`Provider ${name} modelsHeaders must be an object`);
    }

    for (const [headerName, value] of Object.entries(provider.modelsHeaders)) {
      if (!headerName.trim() || typeof value !== 'string') {
        throw new Error(`Provider ${name} modelsHeaders must contain string header values`);
      }
    }
  }
}

function rejectSecretModelHeaders(provider, name) {
  // `headers` reaches the real provider request, so it needs the same scrutiny as
  // `modelsHeaders`, which only ever reaches the catalog endpoint.
  const fields = [
    { key: 'modelsHeaders', label: 'model headers' },
    { key: 'headers', label: 'request headers' },
  ];

  for (const { key, label } of fields) {
    for (const [headerName, value] of Object.entries(provider[key] || {})) {
      const combined = `${headerName}: ${value}`;
      if (/authorization|cookie|session|credential|password|api[-_]?key|token|secret|bearer|x-auth/i.test(combined)) {
        throw new Error(`Secret ${label} are not allowed for provider ${name}. Use apiKeyEnv or bearerTokenEnv instead.`);
      }
    }
  }
}

function normalizeAliases(value, name) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error(`Provider ${name} aliases must be an array`);

  const aliases = value.map((alias) => requiredString(alias, `Provider ${name} aliases must be non-empty strings`));
  for (const alias of aliases) {
    if (!PROVIDER_ID_PATTERN.test(alias)) {
      throw new Error(`Provider alias "${alias}" may contain only letters, numbers, dots, underscores, and hyphens`);
    }
  }

  return [...new Set(aliases)];
}

function normalizeEnvNames(value, providerName, field) {
  if (value == null) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new Error(`Provider ${providerName} ${field} cannot be empty`);

  const normalized = values.map((name) => requiredString(
    name,
    `Provider ${providerName} ${field} must contain environment variable names`
  ));
  for (const name of normalized) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`Provider ${providerName} ${field} contains an invalid environment variable name`);
    }
  }

  // Always an array, even when the config gave a single string: every consumer
  // iterates over these, and returning a bare string crashed them at runtime.
  return [...new Set(normalized)];
}

function normalizeStringList(value, providerName, field) {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Provider ${providerName} ${field} must be a non-empty array`);
  }

  const normalized = value.map((entry) => requiredString(
    entry,
    `Provider ${providerName} ${field} must contain non-empty strings`
  ));
  return [...new Set(normalized)];
}

function assertUniqueProviderNames(providers) {
  const claimed = new Map();
  for (const provider of providers) {
    for (const value of [provider.id, provider.name, ...(provider.aliases || [])]) {
      const normalized = value.toLowerCase();
      if (normalized === 'native') {
        throw new Error(`Provider ${provider.name} cannot use reserved name "native"`);
      }

      const existing = claimed.get(normalized);
      if (existing && existing !== provider) {
        throw new Error(`Provider identifier "${value}" is used by both ${existing.name} and ${provider.name}`);
      }
      claimed.set(normalized, provider);
    }
  }
}

function validateHttpUrl(value, label) {
  const input = requiredString(value, `${label} is required`);
  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error(`${label} must be an absolute URL`, { cause: error });
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY_NAME_PATTERN.test(name)) {
      throw new Error(`${label} must not contain credential-like query parameters`);
    }
  }

  return url.href.replace(/\/$/, '');
}

function requiredString(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value.trim();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readFirstEnv(env, names) {
  const candidates = Array.isArray(names) ? names : names ? [names] : [];
  for (const name of candidates) {
    if (typeof env[name] === 'string' && env[name].trim()) return env[name].trim();
  }
  return null;
}

function defaultConfigPath(env) {
  if (process.platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'copilot-byok-switcher', 'providers.json');
  }

  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'copilot-byok-switcher', 'providers.json');
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function slug(value) {
  return String(value || 'provider')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
