// Turns configured providers into the entries Copilot CLI expects from GET /models.
//
// The shape mirrors GitHub's own model entries: if one declares capabilities the model
// does not have (tool calling, streaming), the harness fails mid-session.

const ID_PREFIX = 'byok';

// The levels Copilot offers. Overridable per model, since they differ: Claude
// Sonnet 4.6 has no `xhigh`, Gemini stops at `high`.
const DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high'];

/**
 * @param {object[]} providers   Already-resolved providers (with apiKey where needed).
 * @returns {{entries: object[], routes: Map<string, {provider: object, model: object, adapterKind?: string}>}}
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
        const taken = routes.get(id);
        if (taken.model.model !== model.model) {
          onEvent({
            type: 'error',
            message: `${provider.id}: "${model.model}" and "${taken.model.model}" collide as ${id}; keeping the first`,
          });
        }
        continue;
      }

      routes.set(id, { provider, model, adapterKind: model.adapterKind ?? provider.adapterKind });
      entries.push(buildEntry({ id, provider, model }));
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
