import http from 'node:http';
import https from 'node:https';
import { isDeepStrictEqual } from 'node:util';

import { AdapterEventError } from './events.mjs';

const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicAdapter({ providerIdleTimeoutMs }) {
  return Object.freeze({
    kind: 'anthropic',
    forward(context) {
      return forwardAnthropic({ ...context, providerIdleTimeoutMs });
    },
  });
}

function forwardAnthropic({ res, payload, route, onEvent, providerIdleTimeoutMs, signal }) {
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

  onEvent({ type: 'route', provider: provider.id, model: model.model, adapter: 'anthropic' });
  const providerReq = client.request({ signal,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers,
  }, (providerRes) => {
    if (signal?.aborted || res.destroyed) {
      providerRes.resume();
      return;
    }
    if ((providerRes.statusCode || 500) >= 300) {
      res.writeHead(providerRes.statusCode, providerRes.headers);
      providerRes.pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    translateSse(providerRes, res, (event) => onEvent({ ...event, provider: provider.id }));
  });

  let timedOut = false;
  providerReq.setTimeout(providerIdleTimeoutMs, () => {
    timedOut = true;
    providerReq.destroy(new Error('provider idle timeout'));
  });
  providerReq.on('error', (error) => {
    if (signal?.aborted || res.destroyed) return;
    const category = timedOut ? 'timeout' : error.code === 'ABORT_ERR' ? 'cancelled' : 'upstream';
    const safe = new AdapterEventError(
      timedOut ? `Provider produced no data for ${Math.round(providerIdleTimeoutMs / 1000)} seconds.`
        : category === 'cancelled' ? 'Request cancelled.' : `${provider.name} is unreachable.`,
      { category, retryable: category === 'timeout' || category === 'upstream', cause: error },
    );
    onEvent({ type: 'error', provider: provider.id, error: safe.toEvent().error });
    respondJson(res, safe.status || 502, { error: safe.toEvent().error });
  });
  res.on('close', () => {
    if (!res.writableEnded) providerReq.destroy();
  });
  providerReq.end(body);
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
  const supportedKeywords = new Set([
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
  const unknownKeyword = Object.keys(schema).find((key) => !supportedKeywords.has(key));
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
    const validTypes = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
    if (typeof schema.type === 'string' && validTypes.has(schema.type)) {
      result.type = schema.type;
    } else if (Array.isArray(schema.type)
      && schema.type.length
      && schema.type.every((entry) => typeof entry === 'string' && validTypes.has(entry))
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

function translateSse(source, res, onEvent) {
  let buffer = '';
  let finished = false;
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    if (reason && !res.destroyed) {
      const error = new AdapterEventError(reason, { category: 'truncated', retryable: true });
      onEvent({ type: 'error', error: error.toEvent().error });
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleFrame(frame, res, onEvent, () => { finished = true; });
    }
  });
  source.on('end', () => finish(finished ? undefined : 'stream ended before message_stop'));
  source.on('error', (error) => finish(`stream interrupted: ${error.message}`));
  source.on('aborted', () => finish('stream aborted by the remote end'));
}

function handleFrame(frame, res, onEvent, markFinished) {
  const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
  const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  if (!data) return;
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    return;
  }
  if (event === 'message_start') {
    writeChunk(res, value.message?.id, value.message?.model, { role: 'assistant' });
  } else if (event === 'content_block_delta' && value.delta?.type === 'text_delta') {
    onEvent({ type: 'text', text: value.delta.text });
    writeChunk(res, undefined, undefined, { content: value.delta.text });
  } else if (event === 'message_delta') {
    writeChunk(res, undefined, undefined, {}, mapStopReason(value.delta?.stop_reason));
  } else if (event === 'error') {
    const error = new AdapterEventError(value.error?.message || 'Anthropic provider error.', { category: 'upstream', retryable: false });
    onEvent({ type: 'error', error: error.toEvent().error });
  } else if (event === 'message_stop') {
    res.write('data: [DONE]\n\n');
    markFinished();
    res.end();
  }
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

function mapStopReason(reason) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return reason ? 'stop' : null;
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
