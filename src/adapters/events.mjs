export const ADAPTER_EVENT_TYPES = Object.freeze({
  TEXT: 'text',
  REASONING: 'reasoning',
  TOOL_FRAGMENT: 'tool-fragment',
  TOOL: 'tool',
  USAGE: 'usage',
  FINISH: 'finish',
  METADATA: 'metadata',
  ERROR: 'error',
});

const ERROR_CATEGORIES = new Set([
  'authentication',
  'authorization',
  'rate-limit',
  'invalid-request',
  'not-found',
  'timeout',
  'cancelled',
  'upstream',
  'malformed-response',
  'unsupported',
  'unknown',
]);

export class AdapterEventError extends Error {
  constructor(message, { category = 'unknown', status, retryable = false, metadata } = {}) {
    super(message);
    this.name = 'AdapterEventError';
    if (!ERROR_CATEGORIES.has(category)) {
      throw new TypeError(`Unknown adapter error category "${category}".`);
    }
    if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) {
      throw new TypeError('Adapter error status must be an HTTP status code.');
    }
    this.category = category;
    this.status = status;
    this.retryable = Boolean(retryable);
    this.metadata = metadata === undefined ? undefined : normalizeMetadata(metadata);
  }

  toEvent() {
    return adapterEvent({
      type: ADAPTER_EVENT_TYPES.ERROR,
      error: {
        category: this.category,
        message: this.message,
        retryable: this.retryable,
        ...(this.status === undefined ? {} : { status: this.status }),
      },
      ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
    });
  }
}

export function adapterEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Adapter events must be objects.');
  }

  const normalized = structuredClone(event);
  switch (normalized.type) {
    case ADAPTER_EVENT_TYPES.TEXT:
    case ADAPTER_EVENT_TYPES.REASONING:
      requireString(normalized.text, `${normalized.type}.text`, true);
      break;
    case ADAPTER_EVENT_TYPES.TOOL_FRAGMENT:
      normalizeToolIdentity(normalized);
      if (normalized.name === undefined && normalized.arguments === undefined) {
        throw new TypeError('Tool fragments must contain a name or arguments fragment.');
      }
      if (normalized.name !== undefined) requireString(normalized.name, 'tool-fragment.name', true);
      if (normalized.arguments !== undefined) requireString(normalized.arguments, 'tool-fragment.arguments', true);
      break;
    case ADAPTER_EVENT_TYPES.TOOL:
      normalizeToolIdentity(normalized);
      requireString(normalized.name, 'tool.name');
      requireString(normalized.arguments, 'tool.arguments', true);
      break;
    case ADAPTER_EVENT_TYPES.USAGE:
      requireObject(normalized.usage, 'usage.usage');
      for (const [key, value] of Object.entries(normalized.usage)) {
        if (!Number.isFinite(value) || value < 0) {
          throw new TypeError(`usage.usage.${key} must be a non-negative number.`);
        }
      }
      break;
    case ADAPTER_EVENT_TYPES.FINISH:
      requireString(normalized.reason, 'finish.reason');
      break;
    case ADAPTER_EVENT_TYPES.METADATA:
      requireString(normalized.namespace, 'metadata.namespace');
      requireObject(normalized.data, 'metadata.data');
      break;
    case ADAPTER_EVENT_TYPES.ERROR:
      normalizeError(normalized);
      break;
    default:
      throw new TypeError(`Unknown adapter event type "${normalized.type}".`);
  }

  if (normalized.metadata !== undefined) normalized.metadata = normalizeMetadata(normalized.metadata);
  return deepFreeze(normalized);
}

export function assembleAdapterEvents(inputEvents) {
  const state = {
    events: [],
    text: '',
    reasoning: '',
    tools: new Map(),
    metadata: {},
    usage: [],
    finishes: [],
    errors: [],
    nextToolOrder: 0,
  };

  for (const inputEvent of inputEvents) applyEvent(state, adapterEvent(inputEvent));

  const tools = [...new Set(state.tools.values())]
    .sort(compareTools)
    .map((tool) => {
      const assembled = { ...tool };
      delete assembled.order;
      return deepFreeze(assembled);
    });

  return deepFreeze({
    events: state.events,
    text: state.text,
    reasoning: state.reasoning,
    tools,
    usage: state.usage,
    finishes: state.finishes,
    metadata: state.metadata,
    errors: state.errors,
  });
}

function applyEvent(state, event) {
  state.events.push(event);
  mergeMetadata(state.metadata, event.metadata);

  switch (event.type) {
    case ADAPTER_EVENT_TYPES.TEXT:
      state.text += event.text;
      break;
    case ADAPTER_EVENT_TYPES.REASONING:
      state.reasoning += event.text;
      break;
    case ADAPTER_EVENT_TYPES.TOOL_FRAGMENT:
      applyToolFragment(state, event);
      break;
    case ADAPTER_EVENT_TYPES.TOOL:
      applyCompletedTool(state, event);
      break;
    case ADAPTER_EVENT_TYPES.USAGE:
      state.usage.push(event.usage);
      break;
    case ADAPTER_EVENT_TYPES.FINISH:
      state.finishes.push(event.reason);
      break;
    case ADAPTER_EVENT_TYPES.METADATA:
      appendMetadata(state.metadata, event.namespace, event.data);
      break;
    case ADAPTER_EVENT_TYPES.ERROR:
      state.errors.push(event.error);
      break;
  }
}

function applyToolFragment(state, event) {
  const tool = resolveTool(state, event);
  if (tool.complete) throw new TypeError(`Tool "${tool.id ?? tool.index}" received a fragment after completion.`);
  if (event.name !== undefined) tool.name += event.name;
  if (event.arguments !== undefined) tool.arguments += event.arguments;
}

function applyCompletedTool(state, event) {
  const tool = resolveTool(state, event);
  if (tool.complete) throw new TypeError(`Tool "${tool.id ?? tool.index}" completed more than once.`);
  if (tool.name && tool.name !== event.name) {
    throw new TypeError(`Completed tool name "${event.name}" does not match assembled name "${tool.name}".`);
  }
  if (tool.arguments && tool.arguments !== event.arguments) {
    throw new TypeError(`Completed tool arguments for "${tool.id ?? tool.index}" do not match assembled fragments.`);
  }
  tool.name = event.name;
  tool.arguments = event.arguments;
  if (Object.hasOwn(event, 'result')) tool.result = event.result;
  tool.complete = true;
}

function resolveTool(state, event) {
  const idIdentity = event.id === undefined ? undefined : `id:${event.id}`;
  const indexIdentity = event.index === undefined ? undefined : `index:${event.index}`;
  const idTool = state.tools.get(idIdentity);
  const indexTool = state.tools.get(indexIdentity);
  if (idTool && indexTool && idTool !== indexTool) {
    throw new TypeError(`Tool "${event.id}" and index ${event.index} refer to different fragmented tools.`);
  }
  let tool = idTool || indexTool;
  if (!tool) {
    tool = {
      ...(event.id === undefined ? {} : { id: event.id }),
      ...(event.index === undefined ? {} : { index: event.index }),
      name: '',
      arguments: '',
      complete: false,
      order: state.nextToolOrder++,
    };
    if (idIdentity) state.tools.set(idIdentity, tool);
    if (indexIdentity) state.tools.set(indexIdentity, tool);
  } else {
    if (event.id !== undefined && tool.id !== undefined && event.id !== tool.id) {
      throw new TypeError(`Tool index ${event.index} changed id from "${tool.id}" to "${event.id}".`);
    }
    if (event.index !== undefined && tool.index !== undefined && event.index !== tool.index) {
      throw new TypeError(`Tool "${event.id}" changed index from ${tool.index} to ${event.index}.`);
    }
    if (tool.id === undefined && event.id !== undefined) tool.id = event.id;
    if (tool.index === undefined && event.index !== undefined) tool.index = event.index;
    if (idIdentity) state.tools.set(idIdentity, tool);
    if (indexIdentity) state.tools.set(indexIdentity, tool);
  }
  return tool;
}

function compareTools(left, right) {
  if (left.index !== undefined && right.index !== undefined && left.index !== right.index) {
    return left.index - right.index;
  }
  if (left.index !== undefined && right.index === undefined) return -1;
  if (left.index === undefined && right.index !== undefined) return 1;
  return left.order - right.order;
}

function normalizeToolIdentity(event) {
  if (event.id === undefined && event.index === undefined) {
    throw new TypeError(`${event.type} must contain an id or index.`);
  }
  if (event.id !== undefined) requireString(event.id, `${event.type}.id`);
  if (event.index !== undefined && (!Number.isInteger(event.index) || event.index < 0)) {
    throw new TypeError(`${event.type}.index must be a non-negative integer.`);
  }
}

function normalizeError(event) {
  requireObject(event.error, 'error.error');
  requireString(event.error.category, 'error.error.category');
  if (!ERROR_CATEGORIES.has(event.error.category)) {
    throw new TypeError(`Unknown adapter error category "${event.error.category}".`);
  }
  requireString(event.error.message, 'error.error.message');
  if (typeof event.error.retryable !== 'boolean') {
    throw new TypeError('error.error.retryable must be a boolean.');
  }
  if (event.error.status !== undefined
    && (!Number.isInteger(event.error.status) || event.error.status < 100 || event.error.status > 599)) {
    throw new TypeError('error.error.status must be an HTTP status code.');
  }
}

function normalizeMetadata(metadata) {
  requireObject(metadata, 'metadata');
  const normalized = {};
  for (const [namespace, value] of Object.entries(metadata)) {
    requireString(namespace, 'metadata namespace');
    requireObject(value, `metadata.${namespace}`);
    normalized[namespace] = value;
  }
  return normalized;
}

function mergeMetadata(target, metadata) {
  if (!metadata) return;
  for (const [namespace, data] of Object.entries(metadata)) appendMetadata(target, namespace, data);
}

function appendMetadata(target, namespace, data) {
  if (!Object.hasOwn(target, namespace)) {
    Object.defineProperty(target, namespace, {
      value: [],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  target[namespace].push(data);
}

function requireString(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
