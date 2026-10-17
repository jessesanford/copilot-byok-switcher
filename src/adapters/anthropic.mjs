import http from 'node:http';
import https from 'node:https';
import { isDeepStrictEqual } from 'node:util';

import { AdapterEventError } from './events.mjs';
import { createStreamingLifecycle } from './lifecycle.mjs';

const ANTHROPIC_VERSION = '2023-06-01';
const JSON_SCHEMA_KEYWORDS = new Set([
  '$anchor', '$comment', '$defs', '$id', '$ref', '$schema',
  'additionalItems', 'additionalProperties', 'allOf', 'anyOf',
  'const', 'contains', 'contentEncoding', 'contentMediaType', 'default',
  'definitions', 'dependencies', 'dependentRequired', 'dependentSchemas',
  'deprecated', 'description', 'else', 'enum', 'examples',
  'exclusiveMaximum', 'exclusiveMinimum', 'format', 'if', 'items',
  'maxContains', 'maximum', 'maxItems', 'maxLength', 'maxProperties',
  'minContains', 'minimum', 'minItems', 'minLength', 'minProperties',
  'multipleOf', 'not', 'oneOf', 'pattern', 'patternProperties',
  'prefixItems', 'properties', 'propertyNames', 'readOnly', 'required',
  'then', 'title', 'type', 'unevaluatedItems', 'unevaluatedProperties',
  'uniqueItems', 'writeOnly',
  'private',
]);
const JSON_SCHEMA_TYPES = new Set([
  'array', 'boolean', 'integer', 'null', 'number', 'object', 'string',
]);
const STOP_REASON_MAPPINGS = new Map([
  ['max_tokens', Object.freeze({ chat: 'length', normalized: 'length' })],
  ['tool_use', Object.freeze({ chat: 'tool_calls', normalized: 'tool-calls' })],
]);
const DEFAULT_STOP_REASON_MAPPING = Object.freeze({ chat: 'stop', normalized: 'stop' });

export function createAnthropicAdapter({ providerIdleTimeoutMs }) {
  return Object.freeze({
    kind: 'anthropic',
    forward(context) {
      return forwardAnthropic({ ...context, providerIdleTimeoutMs });
    },
  });
}

function forwardAnthropic({ req, res, payload, route, onEvent, providerIdleTimeoutMs, signal }) {
  const { provider, model } = route;
  const target = new URL(`${provider.baseUrl.replace(/\/$/, '')}/messages`);
  const client = target.protocol === 'https:' ? https : http;
  let outbound;
  try {
    outbound = toAnthropicRequest(payload, route);
  } catch (error) {
    const safe = new AdapterEventError(error.message, { category: 'invalid-request', status: 400 });
    onEvent({ type: 'error', provider: provider.id, error: safe.toEvent().error });
    respondJson(res, 400, { error: safe.toEvent().error });
    return;
  }
  const lifecycle = createStreamingLifecycle({ res, onEvent, provider: provider.id, signal });
  const body = Buffer.from(JSON.stringify(outbound), 'utf8');
  const headers = {
    accept: 'text/event-stream',
    ...(provider.headers || {}),
    'anthropic-version': provider.anthropicVersion || ANTHROPIC_VERSION,
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    host: target.host,
  };
  if (provider.apiKey && route.authPolicy.type !== 'none') {
    headers[route.authPolicy.header || 'x-api-key'] = provider.apiKey;
  }

  onEvent({
    type: 'route',
    provider: provider.id,
    model: model.model,
    adapter: 'anthropic',
    inboundPath: req.url,
    outboundPath: target.pathname,
    messageCount: payload.messages?.length ?? 0,
    toolCount: payload.tools?.length ?? payload.functions?.length ?? 0,
    roles: Array.isArray(payload.messages)
      ? payload.messages.map(({ role }) => role).filter((role) => typeof role === 'string')
      : [],
  });
  const providerReq = client.request({ signal,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers,
  }, (providerRes) => {
    lifecycle.setSource(providerRes);
    if (lifecycle.terminal || signal?.aborted || res.destroyed) {
      providerRes.resume();
      return;
    }
    if ((providerRes.statusCode || 500) >= 300) {
      const safe = anthropicHttpError(providerRes.statusCode);
      providerRes.resume();
      lifecycle.fail(safe);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    translateSse(providerRes, res, (event) => onEvent({ ...event, provider: provider.id }), lifecycle);
  });
  lifecycle.setRequest(providerReq);

  let timedOut = false;
  providerReq.setTimeout(providerIdleTimeoutMs, () => {
    if (lifecycle.terminal) return;
    timedOut = true;
    providerReq.destroy(new Error('provider idle timeout'));
  });
  providerReq.on('error', (error) => {
    if (lifecycle.terminal || signal?.aborted || res.destroyed) return;
    const category = timedOut ? 'timeout' : error.code === 'ABORT_ERR' ? 'cancelled' : 'upstream';
    const safe = new AdapterEventError(
      timedOut ? `Provider produced no data for ${Math.round(providerIdleTimeoutMs / 1000)} seconds.`
        : category === 'cancelled' ? 'Request cancelled.' : `${provider.name} is unreachable.`,
      { category, retryable: category === 'timeout' || category === 'upstream', cause: error },
    );
    if (category === 'cancelled') lifecycle.cancel();
    else lifecycle.fail(safe);
  });
  providerReq.end(body);
}

function anthropicHttpError(status = 502) {
  const definitions = {
    400: ['invalid-request', false, 'The Anthropic provider rejected the request.'],
    401: ['authentication', false, 'The Anthropic provider rejected its credentials.'],
    403: ['authorization', false, 'The Anthropic provider denied access.'],
    404: ['not-found', false, 'The Anthropic provider endpoint was not found.'],
    408: ['timeout', true, 'The Anthropic provider timed out.'],
    409: ['upstream', true, 'The Anthropic provider could not complete the request.'],
    413: ['invalid-request', false, 'The Anthropic provider rejected the request as too large.'],
    429: ['rate-limit', true, 'The Anthropic provider rate limit was exceeded.'],
  };
  const [category, retryable, message] = definitions[status]
    || (status >= 500
      ? ['upstream', true, 'The Anthropic provider failed to complete the request.']
      : ['upstream', false, 'The Anthropic provider rejected the request.']);
  return new AdapterEventError(message, { category, status, retryable });
}

function toAnthropicRequest(payload, route) {
  const system = [];
  const messages = [];
  const pendingCalls = new Map();
  const usedCallIds = new Set();
  const reservedCallIds = collectExplicitCallIds(payload.messages);
  let conversationStarted = false;
  if (!Array.isArray(payload.messages)) {
    throw invalidAnthropicRequest('Anthropic requests require a messages array.');
  }
  for (const [index, message] of payload.messages.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw invalidAnthropicRequest(`Anthropic message ${index + 1} must be an object.`);
    }
    if (message.role === 'system' || message.role === 'developer') {
      if (conversationStarted) {
        throw invalidAnthropicRequest('Anthropic system and developer messages must precede the conversation.');
      }
      system.push(...canonicalContent(message.content, { role: message.role, allowImages: false }));
    } else if (message.role === 'user') {
      requireResolvedToolCalls(pendingCalls, message.role);
      conversationStarted = true;
      const content = canonicalContent(message.content, { role: 'user', allowImages: true });
      if (!content.length) {
        throw invalidAnthropicRequest('Anthropic user messages require usable content.');
      }
      messages.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      requireResolvedToolCalls(pendingCalls, message.role);
      conversationStarted = true;
      if (message.function_call != null && message.tool_calls !== undefined) {
        throw invalidAnthropicRequest('Anthropic assistant messages cannot mix function_call and tool_calls.');
      }
      const content = canonicalContent(message.content, { role: 'assistant', allowImages: false, allowEmpty: true });
      addLegacyToolCall(content, pendingCalls, usedCallIds, reservedCallIds, message, index);
      addModernToolCalls(content, pendingCalls, usedCallIds, message.tool_calls, index);
      if (!content.length) {
        throw invalidAnthropicRequest('Anthropic assistant messages require usable content or tool calls.');
      }
      messages.push({ role: 'assistant', content });
    } else if (message.role === 'tool') {
      conversationStarted = true;
      messages.push({
        role: 'user',
        content: [canonicalToolResult(message, pendingCalls, false)],
      });
    } else if (message.role === 'function') {
      conversationStarted = true;
      messages.push({
        role: 'user',
        content: [canonicalToolResult(message, pendingCalls, true)],
      });
    } else {
      throw invalidAnthropicRequest(`Anthropic requests do not support the "${message.role}" message role.`);
    }
  }
  if (pendingCalls.size) {
    throw invalidAnthropicRequest('Anthropic tool calls require immediate results before the conversation ends.');
  }
  if (!messages.length) {
    throw invalidAnthropicRequest('Anthropic requests require at least one usable user or assistant message.');
  }

  const tools = canonicalTools(payload.tools, payload.functions);
  const toolChoice = canonicalToolChoice(payload.tool_choice, tools);
  return {
    model: route.wireModel,
    ...(system.length ? { system } : {}),
    messages,
    max_tokens: canonicalMaxTokens(payload, route),
    stream: true,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
}

function canonicalContent(content, { role, allowImages, allowEmpty = false }) {
  if (content == null && allowEmpty) return [];
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    throw invalidAnthropicRequest(`Anthropic ${role} content must be a string or content array.`);
  }
  const blocks = [];
  for (const [index, part] of content.entries()) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw invalidAnthropicRequest(`Anthropic ${role} content part ${index + 1} must be an object.`);
    }
    if (['text', 'input_text', 'output_text'].includes(part.type)) {
      if (typeof part.text !== 'string') {
        throw invalidAnthropicRequest(`Anthropic ${role} text content requires a string.`);
      }
      if (part.text) blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      if (!allowImages) {
        throw invalidAnthropicRequest(`Anthropic ${role} content does not support images.`);
      }
      blocks.push(canonicalImage(part));
    } else {
      throw invalidAnthropicRequest(`Anthropic ${role} content does not support the "${part.type}" part type.`);
    }
  }
  return blocks;
}

function canonicalImage(part) {
  const value = part.type === 'image_url'
    ? (typeof part.image_url === 'string' ? part.image_url : part.image_url?.url)
    : part.image_url;
  if (typeof value !== 'string') {
    throw invalidAnthropicRequest('Anthropic images require a base64 data URL.');
  }
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !isCanonicalBase64(match[2])) {
    throw invalidAnthropicRequest('Anthropic images require valid JPEG, PNG, GIF, or WebP base64 data.');
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: match[1], data: match[2] },
  };
}

function isCanonicalBase64(value) {
  if (!value || value.length % 4 !== 0) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function requireResolvedToolCalls(pendingCalls, nextRole) {
  if (pendingCalls.size) {
    throw invalidAnthropicRequest(`Anthropic tool calls require immediate results before a "${nextRole}" message.`);
  }
}

function collectExplicitCallIds(messages) {
  const ids = new Set();
  if (!Array.isArray(messages)) return ids;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.role !== 'assistant') continue;
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.id === 'string' && call.id) ids.add(call.id);
    }
    if (message.function_call != null) {
      const id = firstDefined(message.tool_call_id, message.call_id, message.id);
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

function addLegacyToolCall(content, pendingCalls, usedCallIds, reservedCallIds, message, index) {
  if (message.function_call == null) return;
  const call = message.function_call;
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    throw invalidAnthropicRequest('Anthropic legacy function calls must be objects.');
  }
  const explicitId = firstDefined(message.tool_call_id, message.call_id, message.id);
  const id = explicitId === undefined
    ? generatedCallId(index, usedCallIds, reservedCallIds)
    : explicitId;
  addToolUse(content, pendingCalls, usedCallIds, {
    id,
    name: call.name,
    arguments: call.arguments,
    legacy: true,
  });
}

function generatedCallId(index, usedCallIds, reservedCallIds) {
  const base = `call_${index}`;
  let id = base;
  let suffix = 2;
  while (usedCallIds.has(id) || reservedCallIds.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function addModernToolCalls(content, pendingCalls, usedCallIds, calls, messageIndex) {
  if (calls === undefined) return;
  if (!Array.isArray(calls)) {
    throw invalidAnthropicRequest('Anthropic assistant tool_calls must be an array.');
  }
  for (const [callIndex, call] of calls.entries()) {
    if (call?.type !== 'function' || !call.function || typeof call.function !== 'object') {
      throw invalidAnthropicRequest(`Anthropic tool call ${callIndex + 1} in message ${messageIndex + 1} must be a function call.`);
    }
    addToolUse(content, pendingCalls, usedCallIds, {
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      legacy: false,
    });
  }
}

function addToolUse(content, pendingCalls, usedCallIds, call) {
  if (typeof call.id !== 'string' || !call.id) {
    throw invalidAnthropicRequest('Anthropic tool calls require a call ID.');
  }
  if (usedCallIds.has(call.id)) {
    throw invalidAnthropicRequest(`Anthropic tool call ID "${call.id}" is duplicated.`);
  }
  if (typeof call.name !== 'string' || !call.name) {
    throw invalidAnthropicRequest(`Anthropic tool call "${call.id}" requires a function name.`);
  }
  validateAnthropicToolName(call.name, `tool call "${call.id}"`);
  let input;
  if (typeof call.arguments !== 'string') {
    throw invalidAnthropicRequest(`Anthropic tool call "${call.id}" requires JSON arguments.`);
  }
  try {
    input = JSON.parse(call.arguments);
  } catch {
    throw invalidAnthropicRequest(`Anthropic tool call "${call.id}" has malformed JSON arguments.`);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidAnthropicRequest(`Anthropic tool call "${call.id}" arguments must decode to an object.`);
  }
  content.push({ type: 'tool_use', id: call.id, name: call.name, input });
  usedCallIds.add(call.id);
  pendingCalls.set(call.id, { id: call.id, name: call.name, legacy: call.legacy });
}

function canonicalToolResult(message, pendingCalls, legacy) {
  const explicitId = legacy
    ? firstDefined(message.tool_call_id, message.call_id, message.id)
    : message.tool_call_id;
  let call;
  if (explicitId !== undefined) {
    if (typeof explicitId !== 'string' || !explicitId) {
      throw invalidAnthropicRequest('Anthropic tool results require a non-empty call ID.');
    }
    call = pendingCalls.get(explicitId);
  } else if (legacy) {
    const candidates = [...pendingCalls.values()].filter((candidate) => (
      candidate.legacy && (typeof message.name !== 'string' || !message.name || candidate.name === message.name)
    ));
    if (candidates.length > 1) {
      throw invalidAnthropicRequest('Anthropic legacy function result is ambiguous without a call ID.');
    }
    [call] = candidates;
  }
  if (!call) {
    throw invalidAnthropicRequest('Anthropic tool result does not match a pending tool call.');
  }
  if (call.legacy !== legacy) {
    throw invalidAnthropicRequest(`Anthropic ${legacy ? 'function' : 'tool'} result does not match the pending call kind.`);
  }
  if (legacy && typeof message.name === 'string' && message.name && message.name !== call.name) {
    throw invalidAnthropicRequest(`Anthropic function result name "${message.name}" does not match "${call.name}".`);
  }
  pendingCalls.delete(call.id);
  const content = canonicalContent(message.content, {
    role: 'tool result',
    allowImages: true,
    allowEmpty: true,
  });
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: content.length ? content : '',
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function canonicalTools(tools, functions) {
  if (tools !== undefined && !Array.isArray(tools)) {
    throw invalidAnthropicRequest('Anthropic tools must be an array.');
  }
  if (functions !== undefined && !Array.isArray(functions)) {
    throw invalidAnthropicRequest('Anthropic functions must be an array.');
  }
  const result = [];
  const names = new Set();
  for (const tool of tools || []) {
    if (tool?.type !== 'function' || !tool.function || typeof tool.function !== 'object') {
      throw invalidAnthropicRequest('Anthropic tools must contain OpenAI function definitions.');
    }
    result.push(canonicalTool(tool.function, names));
  }
  for (const fn of functions || []) result.push(canonicalTool(fn, names));
  return result;
}

function canonicalTool(fn, names) {
  if (!fn || typeof fn !== 'object' || Array.isArray(fn) || typeof fn.name !== 'string' || !fn.name) {
    throw invalidAnthropicRequest('Anthropic function definitions require a name.');
  }
  validateAnthropicToolName(fn.name, 'function definition');
  if (fn.description !== undefined && typeof fn.description !== 'string') {
    throw invalidAnthropicRequest(`Anthropic function definition "${fn.name}" description must be a string.`);
  }
  if (names.has(fn.name)) {
    throw invalidAnthropicRequest(`Anthropic function definition "${fn.name}" is duplicated.`);
  }
  if (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) {
    throw invalidAnthropicRequest(`Anthropic function definition "${fn.name}" requires a JSON Schema.`);
  }
  names.add(fn.name);
  return {
    name: fn.name,
    ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
    input_schema: canonicalJsonSchema(fn.parameters),
  };
}

function canonicalJsonSchema(schema) {
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw invalidAnthropicRequest('Anthropic JSON Schema entries must be objects or booleans.');
  }
  const unknownKeyword = Object.keys(schema).find((key) => (
    !JSON_SCHEMA_KEYWORDS.has(key) && !key.startsWith('x-')
  ));
  if (unknownKeyword !== undefined) {
    throw invalidAnthropicRequest(`Anthropic JSON Schema keyword "${unknownKeyword}" is unsupported.`);
  }
  const result = {};
  for (const key of [
    '$anchor', '$comment', '$id', '$ref', '$schema', 'title', 'description',
    'format', 'pattern', 'contentEncoding', 'contentMediaType',
  ]) {
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== 'string') {
        throw invalidAnthropicRequest(`Anthropic JSON Schema "${key}" must be a string.`);
      }
      if (key === 'pattern') validateJsonSchemaPattern(schema[key], '"pattern"');
      result[key] = schema[key];
    }
  }
  if (schema.type !== undefined) {
    if (typeof schema.type === 'string' && JSON_SCHEMA_TYPES.has(schema.type)) {
      result.type = schema.type;
    } else if (Array.isArray(schema.type)
      && schema.type.length
      && schema.type.every((entry) => typeof entry === 'string' && JSON_SCHEMA_TYPES.has(entry))
      && new Set(schema.type).size === schema.type.length) {
      result.type = [...schema.type];
    } else {
      throw invalidAnthropicRequest('Anthropic JSON Schema "type" must contain unique valid JSON Schema type names.');
    }
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== 'number' || !Number.isFinite(schema[key])) {
        throw invalidAnthropicRequest(`Anthropic JSON Schema "${key}" must be a finite number.`);
      }
      if (key === 'multipleOf' && schema[key] <= 0) {
        throw invalidAnthropicRequest('Anthropic JSON Schema "multipleOf" must be greater than zero.');
      }
      result[key] = schema[key];
    }
  }
  for (const key of [
    'minLength', 'maxLength', 'minItems', 'maxItems', 'minContains', 'maxContains',
    'minProperties', 'maxProperties',
  ]) {
    if (schema[key] !== undefined) {
      if (!Number.isInteger(schema[key]) || schema[key] < 0) {
        throw invalidAnthropicRequest(`Anthropic JSON Schema "${key}" must be a non-negative integer.`);
      }
      result[key] = schema[key];
    }
  }
  for (const key of ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated']) {
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== 'boolean') {
        throw invalidAnthropicRequest(`Anthropic JSON Schema "${key}" must be a boolean.`);
      }
      result[key] = schema[key];
    }
  }
  for (const key of ['enum', 'examples']) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key])) {
        throw invalidAnthropicRequest(`Anthropic JSON Schema "${key}" must be an array.`);
      }
      if (key === 'enum' && (!schema[key].length || !hasUniqueJsonValues(schema[key]))) {
        throw invalidAnthropicRequest('Anthropic JSON Schema "enum" must contain unique values and must not be empty.');
      }
      result[key] = structuredClone(schema[key]);
    }
  }
  for (const key of ['const', 'default']) {
    if (schema[key] !== undefined) result[key] = structuredClone(schema[key]);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)
      || schema.required.some((entry) => typeof entry !== 'string')
      || new Set(schema.required).size !== schema.required.length) {
      throw invalidAnthropicRequest('Anthropic JSON Schema "required" must contain unique strings.');
    }
    result.required = [...schema.required];
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key])) {
        throw invalidAnthropicRequest(`Anthropic JSON Schema "${key}" must be an array.`);
      }
      if (key !== 'prefixItems' && !schema[key].length) {
        throw invalidAnthropicRequest(`Anthropic JSON Schema "${key}" must not be empty.`);
      }
      result[key] = schema[key].map(canonicalJsonSchema);
    }
  }
  for (const key of [
    'not', 'if', 'then', 'else', 'contains', 'additionalItems', 'additionalProperties',
    'unevaluatedProperties', 'propertyNames', 'unevaluatedItems',
  ]) {
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== 'boolean'
        && (!schema[key] || typeof schema[key] !== 'object' || Array.isArray(schema[key]))) {
        throw invalidAnthropicRequest(`Anthropic JSON Schema "${key}" must be a schema.`);
      }
      result[key] = canonicalJsonSchema(schema[key]);
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      if (!schema.items.length) {
        throw invalidAnthropicRequest('Anthropic JSON Schema tuple "items" must not be empty.');
      }
      result.items = schema.items.map(canonicalJsonSchema);
    } else {
      result.items = canonicalJsonSchema(schema.items);
    }
  }
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    if (schema[key] !== undefined) {
      if (!schema[key] || typeof schema[key] !== 'object' || Array.isArray(schema[key])) {
        throw invalidAnthropicRequest(`Anthropic JSON Schema "${key}" must be an object.`);
      }
      if (key === 'patternProperties') {
        for (const pattern of Object.keys(schema[key])) validateJsonSchemaPattern(pattern, '"patternProperties" name');
      }
      result[key] = Object.fromEntries(
        Object.entries(schema[key]).map(([name, value]) => [name, canonicalJsonSchema(value)]),
      );
    }
  }
  if (schema.dependentRequired !== undefined) {
    if (!schema.dependentRequired || typeof schema.dependentRequired !== 'object'
      || Array.isArray(schema.dependentRequired)
      || Object.values(schema.dependentRequired).some((value) => (
        !Array.isArray(value)
        || value.some((entry) => typeof entry !== 'string')
        || new Set(value).size !== value.length
      ))) {
      throw invalidAnthropicRequest('Anthropic JSON Schema "dependentRequired" must map names to unique string arrays.');
    }
    result.dependentRequired = Object.fromEntries(
      Object.entries(schema.dependentRequired)
        .map(([name, value]) => [name, [...value]]),
    );
  }
  if (schema.dependencies !== undefined) {
    if (!schema.dependencies || typeof schema.dependencies !== 'object' || Array.isArray(schema.dependencies)) {
      throw invalidAnthropicRequest('Anthropic JSON Schema "dependencies" must be an object.');
    }
    result.dependencies = Object.fromEntries(Object.entries(schema.dependencies).map(([name, value]) => {
      if (Array.isArray(value)) {
        if (value.some((entry) => typeof entry !== 'string')
          || new Set(value).size !== value.length) {
          throw invalidAnthropicRequest('Anthropic JSON Schema property dependencies must contain unique strings.');
        }
        return [name, [...value]];
      }
      return [name, canonicalJsonSchema(value)];
    }));
  }
  return result;
}

function validateJsonSchemaPattern(pattern, location) {
  try {
    new RegExp(pattern);
  } catch {
    throw invalidAnthropicRequest(`Anthropic JSON Schema ${location} must be a valid regular expression.`);
  }
}

function validateAnthropicToolName(name, location) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw invalidAnthropicRequest(`Anthropic ${location} name must match ^[a-zA-Z0-9_-]{1,64}$.`);
  }
}

function hasUniqueJsonValues(values) {
  return values.every((value, index) => (
    values.findIndex((candidate) => isDeepStrictEqual(candidate, value)) === index
  ));
}

function canonicalToolChoice(choice, tools) {
  if (choice === undefined) return undefined;
  if (choice === 'auto') {
    if (!tools.length) {
      throw invalidAnthropicRequest('Anthropic auto tool choice requires at least one function definition.');
    }
    return { type: 'auto' };
  }
  if (choice === 'required') {
    if (!tools.length) {
      throw invalidAnthropicRequest('Anthropic required tool choice requires at least one function definition.');
    }
    return { type: 'any' };
  }
  if (choice === 'none') {
    throw invalidAnthropicRequest('Anthropic tool choice does not support "none".');
  }
  if (choice?.type === 'function') {
    const name = choice.function?.name || choice.name;
    if (typeof name !== 'string' || !name) {
      throw invalidAnthropicRequest('Anthropic function tool choice requires a function name.');
    }
    if (!tools.some((tool) => tool.name === name)) {
      throw invalidAnthropicRequest(`Anthropic tool choice names undefined function "${name}".`);
    }
    return { type: 'tool', name };
  }
  throw invalidAnthropicRequest('Anthropic tool choice must be auto, required, or one named function.');
}

function canonicalMaxTokens(payload, route) {
  const requested = payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens;
  if (requested !== undefined && (!Number.isInteger(requested) || requested <= 0)) {
    throw invalidAnthropicRequest('Anthropic max tokens must be a positive integer.');
  }
  const configured = route.model.maxOutputTokens;
  if (configured !== undefined && (!Number.isInteger(configured) || configured <= 0)) {
    throw invalidAnthropicRequest('Anthropic configured max output tokens must be a positive integer.');
  }
  return Math.min(requested ?? configured ?? 4096, configured ?? Number.MAX_SAFE_INTEGER);
}

function invalidAnthropicRequest(message) {
  return new AdapterEventError(message, {
    category: 'invalid-request',
    status: 400,
    retryable: false,
  });
}

function translateSse(source, res, onEvent, lifecycle) {
  let buffer = '';
  const state = {
    blocks: new Map(),
    seenBlocks: new Set(),
    tools: new Map(),
    toolIds: new Set(),
    usage: {},
    stopReason: undefined,
    messageStarted: false,
    messageDeltaSeen: false,
  };
  const fail = (message, options) => lifecycle.fail(new AdapterEventError(message, options));
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    if (lifecycle.terminal) return;
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop();
    for (const frame of frames) {
      if (lifecycle.terminal) break;
      try {
        handleFrame(frame, res, onEvent, state, lifecycle);
      } catch (error) {
        fail(error.message, { category: 'malformed-response', retryable: false });
      }
    }
  });
  source.on('end', () => {
    if (lifecycle.terminal) return;
    fail(
      buffer.trim()
        ? 'The Anthropic provider stream ended with an incomplete frame.'
        : 'The Anthropic provider stream ended before message_stop.',
      { category: 'truncated', retryable: true },
    );
  });
  source.on('error', () => {
    if (lifecycle.terminal) return;
    fail('The Anthropic provider response stream was interrupted.', {
      category: 'truncated',
      retryable: true,
    });
  });
  source.on('aborted', () => {
    if (lifecycle.terminal) return;
    fail('The Anthropic provider response stream was aborted by the remote end.', {
      category: 'truncated',
      retryable: true,
    });
  });
}

function handleFrame(frame, res, onEvent, state, lifecycle) {
  const { event, value } = parseAnthropicFrame(frame);
  if (event === 'message_start') {
    handleMessageStart(value, res, onEvent, state);
  } else if (event === 'content_block_start') {
    handleContentBlockStart(value, res, onEvent, state);
  } else if (event === 'content_block_delta') {
    handleContentBlockDelta(value, res, onEvent, state);
  } else if (event === 'content_block_stop') {
    handleContentBlockStop(value, onEvent, state);
  } else if (event === 'message_delta') {
    handleMessageDelta(value, onEvent, state);
  } else if (event === 'error') {
    lifecycle.fail(anthropicStreamError(value.error));
  } else if (event === 'message_stop') {
    handleMessageStop(res, onEvent, state, lifecycle);
  } else if (event !== 'ping') {
    throw new Error('The Anthropic provider stream contained an unsupported event.');
  }
}

function parseAnthropicFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const eventLines = lines.filter((line) => line.startsWith('event:'));
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (eventLines.length !== 1 || !dataLines.length) {
    throw new Error('The Anthropic provider stream contained a malformed SSE frame.');
  }
  const event = eventLines[0].slice(6).trim();
  const data = dataLines.map((line) => line.slice(5).trimStart()).join('\n').trim();
  if (!event || !data) throw new Error('The Anthropic provider stream contained an incomplete SSE frame.');
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error('The Anthropic provider stream contained invalid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== event) {
    throw new Error('The Anthropic provider stream contained an invalid event shape.');
  }
  return { event, value };
}

function handleMessageStart(value, res, onEvent, state) {
  if (state.messageStarted) {
    throw new Error('The Anthropic provider stream contained an invalid message lifecycle.');
  }
  const { id, model, usage } = value.message || {};
  if (!value.message || typeof value.message !== 'object') {
    throw new Error('Anthropic message_start requires a message.');
  }
  state.messageStarted = true;
  onEvent({
    type: 'metadata',
    namespace: 'anthropic',
    data: { message: { ...(id === undefined ? {} : { id }), ...(model === undefined ? {} : { model }) } },
  });
  emitAnthropicUsage(onEvent, state.usage, usage);
  writeChunk(res, id, model, { role: 'assistant' });
}

function handleContentBlockStart(value, res, onEvent, state) {
  requireContentPhase(state);
  const block = value.content_block;
  if (!block?.type || !Number.isInteger(value.index) || value.index < 0) {
    throw new Error('Anthropic content_block_start requires a valid block and index.');
  }
  if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)
    || state.seenBlocks.has(value.index)) {
    throw new Error('The Anthropic provider stream contained an invalid content block.');
  }
  state.seenBlocks.add(value.index);
  state.blocks.set(value.index, block.type);
  const data = {
    contentBlock: { index: value.index, type: block.type },
    ...(block.type === 'redacted_thinking' ? { redactedThinking: block.data } : {}),
  };
  onEvent({ type: 'metadata', namespace: 'anthropic', data });
  if (block.type !== 'tool_use') return;
  if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) {
    throw new Error('Anthropic tool blocks require an ID and function name.');
  }
  if (state.toolIds.has(block.id)) {
    throw new Error('The Anthropic provider stream contained a duplicate tool ID.');
  }
  state.toolIds.add(block.id);
  const tool = {
    id: block.id,
    index: value.index,
    name: block.name,
    arguments: '',
  };
  state.tools.set(value.index, tool);
  onEvent({ type: 'tool-fragment', ...tool });
  writeChunk(res, undefined, undefined, {
    tool_calls: [{
      index: tool.index,
      id: tool.id,
      type: 'function',
      function: { name: tool.name, arguments: '' },
    }],
  });
}

function handleContentBlockDelta(value, res, onEvent, state) {
  if (value.delta?.type === 'text_delta') {
    requireContentPhase(state);
    handleTextDelta(value, res, onEvent, state);
  } else if (value.delta?.type === 'thinking_delta') {
    requireContentPhase(state);
    handleThinkingDelta(value, onEvent, state);
  } else if (value.delta?.type === 'signature_delta') {
    requireContentPhase(state);
    handleSignatureDelta(value, onEvent, state);
  } else if (value.delta?.type === 'input_json_delta') {
    requireContentPhase(state);
    handleToolDelta(value, res, onEvent, state);
  } else {
    throw new Error('The Anthropic provider stream contained an unsupported content delta.');
  }
}

function handleTextDelta(value, res, onEvent, state) {
  if (state.blocks.get(value.index) !== 'text' || typeof value.delta.text !== 'string') {
    throw new Error('The Anthropic provider stream contained an invalid text delta.');
  }
  onEvent({ type: 'text', text: value.delta.text });
  writeChunk(res, undefined, undefined, { content: value.delta.text });
}

function handleThinkingDelta(value, onEvent, state) {
  if (state.blocks.get(value.index) !== 'thinking' || typeof value.delta.thinking !== 'string') {
    throw new Error('The Anthropic provider stream contained an invalid thinking delta.');
  }
  onEvent({ type: 'reasoning', text: value.delta.thinking });
}

function handleSignatureDelta(value, onEvent, state) {
  if (state.blocks.get(value.index) !== 'thinking' || typeof value.delta.signature !== 'string') {
    throw new Error('The Anthropic provider stream contained an invalid signature delta.');
  }
  onEvent({
    type: 'metadata',
    namespace: 'anthropic',
    data: {
      contentBlock: {
        index: value.index,
        type: 'thinking',
      },
      signature: value.delta.signature,
    },
  });
}

function handleToolDelta(value, res, onEvent, state) {
  const tool = state.tools.get(value.index);
  if (state.blocks.get(value.index) !== 'tool_use'
    || !tool
    || typeof value.delta.partial_json !== 'string') {
    throw new Error('The Anthropic provider stream contained an invalid tool delta.');
  }
  tool.arguments += value.delta.partial_json;
  onEvent({
    type: 'tool-fragment',
    index: tool.index,
    id: tool.id,
    arguments: value.delta.partial_json,
  });
  writeChunk(res, undefined, undefined, {
    tool_calls: [{
      index: tool.index,
      function: { arguments: value.delta.partial_json },
    }],
  });
}

function handleContentBlockStop(value, onEvent, state) {
  requireContentPhase(state);
  const tool = state.tools.get(value.index);
  if (!Number.isInteger(value.index) || value.index < 0 || !state.blocks.has(value.index)) {
    throw new Error('The Anthropic provider stream contained an invalid content block stop.');
  }
  if (tool) {
    let argumentsValue;
    try {
      argumentsValue = JSON.parse(tool.arguments || '{}');
    } catch {
      throw new Error('The Anthropic provider stream contained malformed tool arguments.');
    }
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
      throw new Error('The Anthropic provider stream contained invalid tool arguments.');
    }
    onEvent({ type: 'tool', ...tool });
    state.tools.delete(value.index);
  }
  state.blocks.delete(value.index);
}

function handleMessageDelta(value, onEvent, state) {
  requireContentPhase(state);
  if (!value.delta || typeof value.delta !== 'object') {
    throw new Error('Anthropic message_delta requires a delta.');
  }
  state.messageDeltaSeen = true;
  const stopReason = value.delta?.stop_reason;
  if (typeof stopReason !== 'string' || !stopReason.trim()) {
    throw new Error('The Anthropic provider stream contained an invalid terminal stop reason.');
  }
  emitAnthropicUsage(onEvent, state.usage, value.usage);
  state.stopReason = stopReason;
}

function handleMessageStop(res, onEvent, state, lifecycle) {
  if (!state.messageStarted || !state.messageDeltaSeen) {
    throw new Error('The Anthropic provider stream contained an invalid message lifecycle.');
  }
  if (state.blocks.size || state.tools.size) {
    throw new Error('The Anthropic provider stream ended with incomplete content blocks.');
  }
  if (state.stopReason) {
    const mapping = stopReasonMapping(state.stopReason);
    onEvent({
      type: 'finish',
      reason: mapping.normalized,
      metadata: { anthropic: { stopReason: state.stopReason } },
    });
    writeChunk(res, undefined, undefined, {}, mapping.chat);
  }
  lifecycle.complete();
}

function requireContentPhase(state) {
  if (!state.messageStarted || state.messageDeltaSeen) {
    throw new Error('The Anthropic provider stream contained an invalid message lifecycle.');
  }
}

function anthropicStreamError(nativeError) {
  const type = nativeError?.type;
  const definitions = {
    authentication_error: ['authentication', false],
    permission_error: ['authorization', false],
    rate_limit_error: ['rate-limit', true],
    request_too_large: ['invalid-request', false],
    invalid_request_error: ['invalid-request', false],
    not_found_error: ['not-found', false],
    overloaded_error: ['upstream', true],
    api_error: ['upstream', true],
  };
  const [category, retryable] = definitions[type] || ['upstream', false];
  return new AdapterEventError('The Anthropic provider stream failed.', {
    category,
    retryable,
  });
}

function emitAnthropicUsage(onEvent, accumulated, nativeUsage) {
  if (!nativeUsage || typeof nativeUsage !== 'object' || Array.isArray(nativeUsage)) return;
  for (const [nativeName, normalizedName] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
    ['cache_read_input_tokens', 'cacheReadInputTokens'],
  ]) {
    const value = nativeUsage[nativeName];
    if (Number.isFinite(value) && value >= 0) accumulated[normalizedName] = value;
  }
  if (!Object.keys(accumulated).length) return;
  const usage = { ...accumulated };
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens
      + (usage.cacheCreationInputTokens || 0)
      + (usage.cacheReadInputTokens || 0)
      + usage.outputTokens;
  }
  onEvent({ type: 'usage', usage });
}

function writeChunk(res, id, model, delta, finishReason = null) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify({
    ...(id ? { id } : {}),
    object: 'chat.completion.chunk',
    ...(model ? { model } : {}),
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}

function stopReasonMapping(reason) {
  return STOP_REASON_MAPPINGS.get(reason) || DEFAULT_STOP_REASON_MAPPING;
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
