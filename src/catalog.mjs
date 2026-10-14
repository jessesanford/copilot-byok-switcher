// Turns configured providers into the entries Copilot CLI expects from GET /models.
//
// The shape mirrors GitHub's own model entries: if one declares capabilities the model
// does not have (tool calling, streaming), the harness fails mid-session.

import { DEFAULT_ADAPTER_KIND } from './adapters/registry.mjs';

const ID_PREFIX = 'byok';
const DEFAULT_ENDPOINT_FAMILY = 'chat-completions';
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*$/;

// The levels Copilot offers. Overridable per model, since they differ: Claude
// Sonnet 4.6 has no `xhigh`, Gemini stops at `high`.
const DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high'];

/**
 * @param {object[]} providers   Already-resolved providers (with apiKey where needed).
 * @returns {{entries: object[], routes: Map<string, object>}}
 */
export function buildCatalog(providers, onEvent = () => {}) {
  const entries = [];
  const routes = new Map();

  for (const provider of providers) {
    for (const model of provider.models || []) {
      const id = buildModelId(provider.id, model.model);

      // Distinct names can slugify to the same id (gpt-4.1 and gpt-4-1). Dropping
      // the second silently would make a configured model vanish from the picker.
      if (routes.has(id)) {
        const message = `Duplicate route id "${id}" for ${provider.id}:${model.model}.`;
        onEvent({ type: 'error', message });
        throw new TypeError(message);
      }

      const entry = buildEntry({ id, provider, model });
      routes.set(id, buildRoute({ id, provider, model, entry }));
      entries.push(entry);
    }
  }

  return { entries, routes };
}

/** Stable id without "/": the CLI also uses it as a key in its own settings. */
export function buildModelId(providerId, modelName) {
  const slug = `${providerId}-${modelName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${ID_PREFIX}-${slug}`;
}

export function isByokModelId(value) {
  return typeof value === 'string' && value.startsWith(`${ID_PREFIX}-`);
}

function buildRoute({ id, provider, model, entry }) {
  const adapterKind = routeIdentifier(model.adapterKind ?? provider.adapterKind ?? DEFAULT_ADAPTER_KIND, 'adapter kind', id);
  const endpointFamily = routeIdentifier(
    model.endpointFamily ?? provider.endpointFamily ?? DEFAULT_ENDPOINT_FAMILY,
    'endpoint family',
    id
  );
  const wireModel = requiredRouteString(model.wireModel ?? model.model, 'wire model', id);
  const authPolicy = normalizeAuthPolicy(model.authPolicy ?? provider.authPolicy, provider, id);

  return deepFreeze({
    provider: cloneValue(provider),
    model: cloneValue(model),
    adapterKind,
    endpointFamily,
    wireModel,
    capabilities: entry.capabilities,
    authPolicy,
  });
}

function routeIdentifier(value, field, id) {
  const normalized = requiredRouteString(value, field, id);
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new TypeError(`Route ${id} ${field} must be a lowercase identifier containing only letters, numbers, and hyphens.`);
  }
  return normalized;
}

function requiredRouteString(value, field, id) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Route ${id} requires a non-empty ${field}.`);
  return value.trim();
}

function normalizeAuthPolicy(policy, provider, id) {
  if (policy == null) {
    return Object.freeze({ type: provider.apiKey ? 'bearer' : 'none' });
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError(`Route ${id} auth policy must be an object.`);
  }
  const type = routeIdentifier(policy.type, 'auth policy type', id);
  if (!['none', 'bearer', 'x-api-key', 'api-key'].includes(type)) {
    throw new TypeError(`Route ${id} auth policy type "${type}" is unsupported.`);
  }
  return deepFreeze({ ...policy, type });
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function buildEntry({ id, provider, model }) {
  // Provider-level switches apply to every model it publishes.
  model = {
    ...model,
    reasoningEffortPicker: model.reasoningEffortPicker ?? provider.reasoningEffortPicker,
  };
  const context = model.contextWindow || 128_000;
  const output = model.maxOutputTokens || 32_000;
  const { promptBudget, outputBudget } = splitBudget(context, output);

  return {
    id,
    name: model.label || `${model.model} (${provider.name})`,
    object: 'model',
    vendor: provider.name,
    version: id,
    preview: false,
    is_chat_default: false,
    is_chat_fallback: false,
    model_picker_enabled: true,
    model_picker_category: pickCategory(context),
    model_picker_price_category: 'low',
    supported_endpoints: ['/chat/completions'],
    capabilities: {
      family: model.family || id,
      object: 'model_capabilities',
      type: 'chat',
      tokenizer: 'o200k_base',
      limits: {
        max_context_window_tokens: context,
        max_prompt_tokens: promptBudget,
        max_output_tokens: outputBudget,
        max_non_streaming_output_tokens: Math.min(outputBudget, 16_000),
      },
      supports: {
        streaming: true,
        tool_calls: true,
        parallel_tool_calls: true,
        structured_outputs: true,
        ...(model.vision ? { vision: true } : {}),
        // Off by default, and deliberately so. Declaring this makes Copilot show
        // its effort selector, but on CLI 1.0.79 the chosen level never reaches a
        // BYOK provider: payloads sent with low and with high are byte-identical,
        // in both wire formats (github/copilot-cli#4012, #3119, #3135). A selector
        // that changes nothing is worse than no selector.
        //
        // Turn it on with `reasoningEffortPicker: true` once the CLI forwards the
        // level again — the router already prefers an incoming reasoning_effort
        // over the configured one, so it will start working with no other change.
        ...(model.reasoning && model.reasoningEffortPicker
          ? { reasoning_effort: model.reasoningEffortLevels || DEFAULT_EFFORT_LEVELS }
          : {}),
      },
    },
  };
}

/**
 * Prompt and output share one context window, so their advertised limits must add
 * up to no more than it. Some models publish an output limit as large as their
 * whole context (Grok 4.5: 500k of 500k), which would leave nothing for the
 * prompt; in that case output is halved. Otherwise output is kept as published
 * and the prompt takes what is left.
 */
function splitBudget(context, output) {
  const outputBudget = output >= context ? Math.floor(context / 2) : output;
  return { outputBudget, promptBudget: Math.max(context - outputBudget, 1) };
}

function pickCategory(context) {
  if (context >= 500_000) return 'powerful';
  if (context >= 200_000) return 'versatile';
  return 'lightweight';
}
