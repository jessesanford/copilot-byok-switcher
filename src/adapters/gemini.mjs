import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

import { AdapterEventError } from './events.mjs';

const UNSUPPORTED_SETTINGS = [
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'parallel_tool_calls',
  'presence_penalty',
  'reasoning_effort',
  'response_format',
  'top_logprobs',
];

export function createGeminiAdapter({ providerIdleTimeoutMs }) {
  return Object.freeze({
    kind: 'gemini',
    forward(context) {
      return forwardGemini({ ...context, providerIdleTimeoutMs });
    },
  });
}

function forwardGemini({ res, payload, route, onEvent, providerIdleTimeoutMs, signal }) {
  const { provider, model } = route;
  const streamId = `gemini-${randomUUID()}`;
  let outbound;
  let target;
  try {
    outbound = toGeminiRequest(payload);
    target = geminiTarget(route);
  } catch (error) {
    const safe = error instanceof AdapterEventError
      ? error
      : invalidGeminiRequest(error.message);
    onEvent({ type: 'error', provider: provider.id, error: safe.toEvent().error });
    respondJson(res, safe.status || 400, { error: safe.toEvent().error });
    return;
  }

  const lifecycle = createLifecycle({ res, onEvent, provider: provider.id, signal });
  const body = Buffer.from(JSON.stringify(outbound), 'utf8');
  const headers = {
    accept: 'text/event-stream',
    ...(provider.headers || {}),
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    host: target.host,
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  onEvent({ type: 'route', provider: provider.id, model: model.model, adapter: 'gemini' });
  const client = target.protocol === 'https:' ? https : http;
  const providerReq = client.request({
    signal,
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
      providerRes.resume();
      lifecycle.fail(geminiHttpError(providerRes.statusCode));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    translateSse(
      providerRes,
      res,
      (event) => onEvent({ ...event, provider: provider.id }),
      lifecycle,
      streamId,
      route.wireModel,
      outbound.generationConfig?.candidateCount || 1,
    );
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

function geminiTarget(route) {
  if (route.endpointFamily !== 'generate-content') {
    throw invalidGeminiRequest('Gemini routes require the generate-content endpoint family.');
  }
  if (route.authPolicy.type !== 'bearer') {
    throw invalidGeminiRequest('Gemini SDC routes require bearer authentication.');
  }
  const base = route.provider.baseUrl.replace(/\/$/, '');
  return new URL(`${base}/models/${encodeURIComponent(route.wireModel)}:streamGenerateContent?alt=sse`);
}

function toGeminiRequest(payload) {
  if (payload.stream !== true) {
    throw invalidGeminiRequest('Gemini requests require streaming.');
  }
  if (!Array.isArray(payload.messages) || !payload.messages.length) {
    throw invalidGeminiRequest('Gemini requests require a non-empty messages array.');
  }
  const systemParts = [];
  const contents = [];
  const pendingCalls = new Map();
  let conversationStarted = false;
  for (const [index, message] of payload.messages.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw invalidGeminiRequest(`Gemini message ${index + 1} must be an object.`);
    }
    if (message.role === 'system' || message.role === 'developer') {
      if (conversationStarted) {
        throw invalidGeminiRequest('Gemini system and developer messages must precede the conversation.');
      }
      systemParts.push(...geminiTextParts(message.content, message.role));
    } else if (message.role === 'user') {
      requireNoPendingCalls(pendingCalls, message.role);
      conversationStarted = true;
      contents.push({ role: 'user', parts: geminiTextParts(message.content, 'user') });
    } else if (message.role === 'assistant') {
      requireNoPendingCalls(pendingCalls, message.role);
      conversationStarted = true;
      const parts = geminiTextParts(message.content, 'assistant', true);
      addGeminiCalls(parts, pendingCalls, message, index);
      if (!parts.length) {
        throw invalidGeminiRequest('Gemini assistant messages require usable content or function calls.');
      }
      contents.push({ role: 'model', parts });
    } else if (message.role === 'tool' || message.role === 'function') {
      conversationStarted = true;
      contents.push({
        role: 'user',
        parts: [geminiFunctionResponse(message, pendingCalls)],
      });
    } else {
      throw invalidGeminiRequest(`Gemini requests do not support the "${message.role}" message role.`);
    }
  }
  if (pendingCalls.size) {
    throw invalidGeminiRequest('Gemini function calls require matching results before the conversation ends.');
  }
  if (!contents.length) {
    throw invalidGeminiRequest('Gemini requests require at least one conversation message.');
  }
  const setting = UNSUPPORTED_SETTINGS.find((name) => payload[name] !== undefined);
  if (setting) {
    throw invalidGeminiRequest(`Gemini requests do not support the "${setting}" setting.`);
  }
  const tools = geminiTools(payload.tools, payload.functions);
  const toolConfig = geminiToolConfig(payload.tool_choice, tools);
  const generationConfig = geminiGenerationConfig(payload);
  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
    ...(toolConfig === undefined ? {} : { toolConfig }),
  };
}

function geminiTextParts(content, role, allowEmpty = false) {
  if (content == null && allowEmpty) return [];
  if (typeof content === 'string') {
    if (!content && !allowEmpty) throw invalidGeminiRequest(`Gemini ${role} content must not be empty.`);
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) {
    throw invalidGeminiRequest(`Gemini ${role} content must be a string or content array.`);
  }
  const parts = [];
  for (const [index, part] of content.entries()) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw invalidGeminiRequest(`Gemini ${role} content part ${index + 1} must be an object.`);
    }
    if (!['text', 'input_text', 'output_text'].includes(part.type) || typeof part.text !== 'string') {
      throw invalidGeminiRequest(`Gemini ${role} content does not support the "${part.type}" part type.`);
    }
    if (part.text) parts.push({ text: part.text });
  }
  if (!parts.length && !allowEmpty) {
    throw invalidGeminiRequest(`Gemini ${role} content requires usable text.`);
  }
  return parts;
}

function requireNoPendingCalls(pendingCalls, nextRole) {
  if (pendingCalls.size) {
    throw invalidGeminiRequest(`Gemini function calls require matching results before a "${nextRole}" message.`);
  }
}

function addGeminiCalls(parts, pendingCalls, message, messageIndex) {
  if (message.function_call != null && message.tool_calls !== undefined) {
    throw invalidGeminiRequest('Gemini assistant messages cannot mix function_call and tool_calls.');
  }
  const calls = message.function_call == null
    ? message.tool_calls
    : [{
        id: message.tool_call_id || message.call_id || message.id || `call_${messageIndex}`,
        type: 'function',
        function: message.function_call,
        legacy: true,
      }];
  if (calls === undefined) return;
  if (!Array.isArray(calls)) {
    throw invalidGeminiRequest('Gemini assistant tool_calls must be an array.');
  }
  for (const [index, call] of calls.entries()) {
    if (call?.type !== 'function' || !call.function || typeof call.function !== 'object') {
      throw invalidGeminiRequest(`Gemini tool call ${index + 1} must be a function call.`);
    }
    if (typeof call.id !== 'string' || !call.id || pendingCalls.has(call.id)) {
      throw invalidGeminiRequest('Gemini function calls require unique call IDs.');
    }
    const { name, arguments: serialized } = call.function;
    if (typeof name !== 'string' || !name) {
      throw invalidGeminiRequest(`Gemini function call "${call.id}" requires a name.`);
    }
    const args = parseJsonObject(serialized, `Gemini function call "${call.id}" arguments`);
    parts.push({ functionCall: { name, args } });
    pendingCalls.set(call.id, { name, legacy: Boolean(call.legacy) });
  }
}

function geminiFunctionResponse(message, pendingCalls) {
  const id = message.tool_call_id || message.call_id;
  let call;
  if (message.role === 'function' && id === undefined) {
    const matches = [...pendingCalls.entries()].filter(([, value]) => value.name === message.name);
    if (matches.length === 1) [call] = matches;
  } else if (typeof id === 'string') {
    call = [id, pendingCalls.get(id)];
  }
  if (!call?.[1]) {
    throw invalidGeminiRequest('Gemini function results must match a pending call.');
  }
  const [callId, pending] = call;
  if (message.name !== undefined && message.name !== pending.name) {
    throw invalidGeminiRequest(`Gemini function result "${callId}" does not match function "${pending.name}".`);
  }
  pendingCalls.delete(callId);
  return {
    functionResponse: {
      name: pending.name,
      response: parseFunctionResponse(message.content),
    },
  };
}

function parseFunctionResponse(content) {
  if (typeof content !== 'string') {
    throw invalidGeminiRequest('Gemini function results require string content.');
  }
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { result: parsed };
  } catch {
    return { result: content };
  }
}

function geminiTools(tools, functions) {
  if (tools !== undefined && functions !== undefined) {
    throw invalidGeminiRequest('Gemini requests cannot mix tools and legacy functions.');
  }
  const definitions = functions === undefined ? tools : functions.map((value) => ({ type: 'function', function: value }));
  if (definitions === undefined) return [];
  if (!Array.isArray(definitions)) throw invalidGeminiRequest('Gemini tools must be an array.');
  const names = new Set();
  return definitions.map((tool, index) => {
    if (tool?.type !== 'function' || !tool.function || typeof tool.function !== 'object') {
      throw invalidGeminiRequest(`Gemini tool ${index + 1} must be a function declaration.`);
    }
    const { name, description, parameters } = tool.function;
    if (typeof name !== 'string' || !name || names.has(name)) {
      throw invalidGeminiRequest('Gemini function declarations require unique names.');
    }
    if (description !== undefined && typeof description !== 'string') {
      throw invalidGeminiRequest(`Gemini function "${name}" description must be a string.`);
    }
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw invalidGeminiRequest(`Gemini function "${name}" requires a parameters schema.`);
    }
    names.add(name);
    return { name, ...(description ? { description } : {}), parameters: structuredClone(parameters) };
  });
}

function geminiToolConfig(choice, tools) {
  if (choice === undefined) return undefined;
  if (!tools.length) throw invalidGeminiRequest('Gemini tool_choice requires function declarations.');
  let functionCallingConfig;
  if (choice === 'auto') functionCallingConfig = { mode: 'AUTO' };
  else if (choice === 'none') functionCallingConfig = { mode: 'NONE' };
  else if (choice === 'required') functionCallingConfig = { mode: 'ANY' };
  else if (choice?.type === 'function' && typeof choice.function?.name === 'string') {
    if (!tools.some(({ name }) => name === choice.function.name)) {
      throw invalidGeminiRequest(`Gemini tool_choice references unknown function "${choice.function.name}".`);
    }
    functionCallingConfig = { mode: 'ANY', allowedFunctionNames: [choice.function.name] };
  } else {
    throw invalidGeminiRequest('Gemini tool_choice must be auto, none, required, or a declared function.');
  }
  return { functionCallingConfig };
}

function geminiGenerationConfig(payload) {
  const config = {};
  optionalFinite(payload.temperature, 'temperature', 0, 2, (value) => { config.temperature = value; });
  optionalFinite(payload.top_p, 'top_p', 0, 1, (value) => { config.topP = value; });
  optionalInteger(payload.seed, 'seed', 0, Number.MAX_SAFE_INTEGER, (value) => { config.seed = value; });
  const maxValues = ['max_tokens', 'max_completion_tokens', 'max_output_tokens']
    .filter((name) => payload[name] !== undefined);
  if (maxValues.length > 1) throw invalidGeminiRequest('Gemini requests cannot specify multiple maximum token settings.');
  if (maxValues.length) {
    optionalInteger(payload[maxValues[0]], maxValues[0], 1, Number.MAX_SAFE_INTEGER, (value) => {
      config.maxOutputTokens = value;
    });
  }
  if (payload.n !== undefined) {
    optionalInteger(payload.n, 'n', 1, 8, (value) => { config.candidateCount = value; });
  }
  if (payload.stop !== undefined) {
    const values = typeof payload.stop === 'string' ? [payload.stop] : payload.stop;
    if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value)) {
      throw invalidGeminiRequest('Gemini stop must be a non-empty string or array of non-empty strings.');
    }
    config.stopSequences = [...values];
  }
  return config;
}

function optionalFinite(value, name, minimum, maximum, assign) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidGeminiRequest(`Gemini ${name} must be between ${minimum} and ${maximum}.`);
  }
  assign(value);
}

function optionalInteger(value, name, minimum, maximum, assign) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidGeminiRequest(`Gemini ${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  assign(value);
}

function parseJsonObject(value, label) {
  if (typeof value !== 'string') throw invalidGeminiRequest(`${label} must be JSON.`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidGeminiRequest(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidGeminiRequest(`${label} must decode to an object.`);
  }
  return parsed;
}

function translateSse(source, res, onEvent, lifecycle, streamId, model, expectedCandidates) {
  let buffer = '';
  const state = { candidates: new Map(), expectedCandidates };
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    if (lifecycle.terminal) return;
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop();
    for (const frame of frames) {
      if (lifecycle.terminal) break;
      try {
        const value = parseGeminiFrame(frame);
        handleGeminiResponse(value, res, onEvent, lifecycle, streamId, model, state);
      } catch (error) {
        lifecycle.fail(new AdapterEventError(error.message, {
          category: 'malformed-response',
          retryable: false,
        }));
      }
    }
  });
  source.on('end', () => {
    if (lifecycle.terminal) return;
    lifecycle.fail(new AdapterEventError(
      buffer.trim()
        ? 'The Gemini provider stream ended with an incomplete frame.'
        : 'The Gemini provider stream ended before STOP.',
      { category: 'truncated', retryable: true },
    ));
  });
  source.on('error', () => {
    if (!lifecycle.terminal) lifecycle.fail(new AdapterEventError(
      'The Gemini provider response stream was interrupted.',
      { category: 'truncated', retryable: true },
    ));
  });
  source.on('aborted', () => {
    if (!lifecycle.terminal) lifecycle.fail(new AdapterEventError(
      'The Gemini provider response stream was aborted by the remote end.',
      { category: 'truncated', retryable: true },
    ));
  });
}

function parseGeminiFrame(frame) {
  const dataLines = frame.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) throw new Error('The Gemini provider stream contained a malformed SSE frame.');
  let value;
  try {
    value = JSON.parse(dataLines.join('\n').trim());
  } catch {
    throw new Error('The Gemini provider stream contained invalid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Gemini provider stream contained an invalid response.');
  }
  return value;
}

function handleGeminiResponse(value, res, onEvent, lifecycle, streamId, model, state) {
  if (value.error !== undefined) {
    lifecycle.fail(geminiStreamError(value.error));
    return;
  }
  emitGeminiUsage(value.usageMetadata, state, onEvent);
  if (value.promptFeedback !== undefined) {
    if (!value.promptFeedback || typeof value.promptFeedback !== 'object' || Array.isArray(value.promptFeedback)) {
      throw new Error('The Gemini provider stream contained invalid prompt feedback.');
    }
    onEvent({ type: 'metadata', namespace: 'gemini', data: { promptFeedback: value.promptFeedback } });
  }
  if (!Array.isArray(value.candidates) || !value.candidates.length) {
    if (value.promptFeedback !== undefined) {
      lifecycle.fail(geminiBlockedError(value.promptFeedback.blockReason));
      return;
    }
    throw new Error('The Gemini provider stream contained an invalid candidate response.');
  }
  for (const [position, candidate] of value.candidates.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('The Gemini provider stream contained an invalid candidate response.');
    }
    const candidateIndex = candidate.index === undefined ? position : candidate.index;
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
      throw new Error('The Gemini provider stream contained an invalid candidate index.');
    }
    const candidateState = geminiCandidateState(state, candidateIndex, res, streamId, model);
    emitGeminiCandidateMetadata(candidate, candidateIndex, onEvent);
    const parts = candidate.content?.parts;
    if (parts !== undefined) {
      if (!Array.isArray(parts)) {
        throw new Error('The Gemini provider stream contained invalid content parts.');
      }
      for (const [partIndex, part] of parts.entries()) {
        handleGeminiPart(part, partIndex, candidateIndex, candidateState, res, onEvent, streamId, model);
      }
    }
    if (candidate.finishReason !== undefined) {
      onEvent({
        type: 'metadata',
        namespace: 'gemini',
        data: { candidate: { index: candidateIndex, finishReason: candidate.finishReason } },
      });
      if (isGeminiBlockedFinish(candidate.finishReason)) {
        lifecycle.fail(geminiBlockedError(candidate.finishReason));
        return;
      }
      const mapping = geminiFinishMapping(candidate.finishReason, candidateState.hasTools);
      onEvent({ type: 'finish', reason: mapping.normalized });
      writeChunk(res, streamId, model, candidateIndex, {}, mapping.chat);
      candidateState.finished = true;
    }
  }
  if ([...state.candidates.values()].filter(({ finished }) => finished).length === state.expectedCandidates) {
    lifecycle.complete();
  }
}

function geminiCandidateState(state, index, res, streamId, model) {
  let candidate = state.candidates.get(index);
  if (!candidate) {
    candidate = { calls: new Map(), finished: false, hasTools: false };
    state.candidates.set(index, candidate);
    writeChunk(res, streamId, model, index, { role: 'assistant' });
  }
  if (candidate.finished) {
    throw new Error('The Gemini provider stream emitted data after a candidate finished.');
  }
  return candidate;
}

function handleGeminiPart(part, partIndex, candidateIndex, state, res, onEvent, streamId, model) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    throw new Error('The Gemini provider stream contained an invalid content part.');
  }
  if (part.text !== undefined) {
    if (typeof part.text !== 'string') {
      throw new Error('The Gemini provider stream contained invalid text.');
    }
    if (part.thought === true) {
      if (part.text) onEvent({ type: 'reasoning', text: part.text });
      emitGeminiThoughtMetadata(part, partIndex, candidateIndex, onEvent);
      return;
    }
    emitGeminiThoughtMetadata(part, partIndex, candidateIndex, onEvent);
    if (!part.text) return;
    onEvent({ type: 'text', text: part.text });
    writeChunk(res, streamId, model, candidateIndex, { content: part.text });
    return;
  }
  if (part.functionCall !== undefined) {
    emitGeminiThoughtMetadata(part, partIndex, candidateIndex, onEvent);
    handleGeminiFunctionCall(
      part.functionCall,
      partIndex,
      candidateIndex,
      state,
      res,
      onEvent,
      streamId,
      model,
    );
    return;
  }
  if (part.thoughtSignature !== undefined) {
    emitGeminiThoughtMetadata(part, partIndex, candidateIndex, onEvent);
    return;
  }
  throw new Error('The Gemini provider stream contained an unsupported content part.');
}

function emitGeminiThoughtMetadata(part, partIndex, candidateIndex, onEvent) {
  if (part.thoughtSignature === undefined) return;
  if (typeof part.thoughtSignature !== 'string' || !part.thoughtSignature) {
    throw new Error('The Gemini provider stream contained an invalid thought signature.');
  }
  onEvent({
    type: 'metadata',
    namespace: 'gemini',
    data: {
      thought: {
        candidateIndex,
        partIndex,
        signature: part.thoughtSignature,
      },
    },
  });
}

function emitGeminiCandidateMetadata(candidate, index, onEvent) {
  if (candidate.safetyRatings !== undefined) {
    if (!Array.isArray(candidate.safetyRatings)) {
      throw new Error('The Gemini provider stream contained invalid safety ratings.');
    }
    onEvent({
      type: 'metadata',
      namespace: 'gemini',
      data: { candidate: { index, safetyRatings: candidate.safetyRatings } },
    });
  }
}

function emitGeminiUsage(native, state, onEvent) {
  if (native === undefined) return;
  if (!native || typeof native !== 'object' || Array.isArray(native)) {
    throw new Error('The Gemini provider stream contained invalid usage metadata.');
  }
  const mappings = {
    promptTokenCount: 'inputTokens',
    candidatesTokenCount: 'outputTokens',
    totalTokenCount: 'totalTokens',
    cachedContentTokenCount: 'cachedInputTokens',
    thoughtsTokenCount: 'reasoningTokens',
    toolUsePromptTokenCount: 'toolUsePromptTokens',
  };
  const usage = {};
  for (const [nativeName, normalizedName] of Object.entries(mappings)) {
    if (native[nativeName] === undefined) continue;
    if (!Number.isFinite(native[nativeName]) || native[nativeName] < 0) {
      throw new Error('The Gemini provider stream contained invalid usage metadata.');
    }
    usage[normalizedName] = native[nativeName];
  }
  const serialized = JSON.stringify(usage);
  if (serialized === state.lastUsage) return;
  state.lastUsage = serialized;
  if (Object.keys(usage).length) onEvent({ type: 'usage', usage });
}

function geminiFinishMapping(reason, hasTools) {
  if (reason === 'STOP') {
    return hasTools
      ? { chat: 'tool_calls', normalized: 'tool-calls' }
      : { chat: 'stop', normalized: 'stop' };
  }
  if (reason === 'MAX_TOKENS') return { chat: 'length', normalized: 'length' };
  throw new Error(`The Gemini provider stream contained unsupported finish reason "${reason}".`);
}

function isGeminiBlockedFinish(reason) {
  return [
    'SAFETY',
    'RECITATION',
    'LANGUAGE',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'MALFORMED_FUNCTION_CALL',
    'IMAGE_SAFETY',
  ].includes(reason);
}

function geminiBlockedError(reason) {
  return new AdapterEventError('The Gemini provider blocked the response.', {
    category: 'upstream',
    retryable: false,
    metadata: { gemini: { blockedReason: reason || 'UNKNOWN' } },
  });
}

function handleGeminiFunctionCall(call, partIndex, candidateIndex, state, res, onEvent, streamId, model) {
  if (!call || typeof call !== 'object' || Array.isArray(call)
    || typeof call.name !== 'string' || !call.name
    || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    throw new Error('The Gemini provider stream contained an invalid function call.');
  }
  const serialized = JSON.stringify(call.args);
  const existing = state.calls.get(partIndex);
  if (existing) {
    if (existing.name !== call.name || existing.arguments !== serialized) {
      throw new Error('The Gemini provider stream changed a function call after emission.');
    }
    return;
  }
  const id = `gemini-call-${candidateIndex}-${partIndex}`;
  const identity = { id, index: partIndex, name: call.name, arguments: serialized };
  state.calls.set(partIndex, identity);
  state.hasTools = true;
  onEvent({ type: 'tool-fragment', id, index: partIndex, name: call.name, arguments: '' });
  onEvent({ type: 'tool-fragment', id, index: partIndex, arguments: serialized });
  onEvent({ type: 'tool', ...identity });
  writeChunk(res, streamId, model, candidateIndex, {
    tool_calls: [{
      index: partIndex,
      id,
      type: 'function',
      function: { name: call.name, arguments: '' },
    }],
  });
  writeChunk(res, streamId, model, candidateIndex, {
    tool_calls: [{ index: partIndex, function: { arguments: serialized } }],
  });
}

function createLifecycle({ res, onEvent, provider, signal }) {
  let terminal = false;
  let request;
  let source;
  const removeListeners = () => {
    signal?.removeEventListener('abort', cancel);
    res.removeListener('close', onClose);
  };
  const release = () => {
    removeListeners();
    if (source && !source.destroyed) source.destroy();
    if (request && !request.destroyed) request.destroy();
  };
  const cancel = () => {
    if (terminal) return;
    terminal = true;
    release();
  };
  const fail = (error) => {
    if (terminal || signal?.aborted || res.destroyed) return;
    terminal = true;
    const payload = error.toEvent().error;
    onEvent({ type: 'error', provider, error: payload });
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ error: payload })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    } else {
      respondJson(res, error.status || 502, { error: payload });
    }
    release();
  };
  const complete = () => {
    if (terminal) return;
    terminal = true;
    removeListeners();
    if (!res.writableEnded && !res.destroyed) res.end('data: [DONE]\n\n');
    if (source && !source.destroyed) source.destroy();
  };
  const onClose = () => {
    if (!res.writableEnded) cancel();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  res.once('close', onClose);
  return {
    get terminal() { return terminal; },
    setRequest(value) {
      request = value;
      if (terminal && !request.destroyed) request.destroy();
    },
    setSource(value) {
      source = value;
      if (terminal && !source.destroyed) source.destroy();
    },
    cancel,
    fail,
    complete,
  };
}

function geminiHttpError(status = 502) {
  const definitions = {
    400: ['invalid-request', false, 'The Gemini provider rejected the request.'],
    401: ['authentication', false, 'The Gemini provider rejected its credentials.'],
    403: ['authorization', false, 'The Gemini provider denied access.'],
    404: ['not-found', false, 'The Gemini provider endpoint was not found.'],
    408: ['timeout', true, 'The Gemini provider timed out.'],
    413: ['invalid-request', false, 'The Gemini provider rejected the request as too large.'],
    429: ['rate-limit', true, 'The Gemini provider rate limit was exceeded.'],
  };
  const [category, retryable, message] = definitions[status]
    || (status >= 500
      ? ['upstream', true, 'The Gemini provider failed to complete the request.']
      : ['upstream', false, 'The Gemini provider rejected the request.']);
  return new AdapterEventError(message, { category, status, retryable });
}

function geminiStreamError(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return new AdapterEventError('The Gemini provider stream failed.', {
      category: 'upstream',
      retryable: false,
    });
  }
  const status = Number.isInteger(error.code) && error.code >= 100 && error.code <= 599
    ? error.code
    : undefined;
  if (status !== undefined) return geminiHttpError(status);
  const retryable = ['UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'DEADLINE_EXCEEDED'].includes(error.status);
  return new AdapterEventError('The Gemini provider stream failed.', {
    category: error.status === 'RESOURCE_EXHAUSTED' ? 'rate-limit' : 'upstream',
    retryable,
  });
}

function invalidGeminiRequest(message) {
  return new AdapterEventError(message, {
    category: 'invalid-request',
    status: 400,
    retryable: false,
  });
}

function writeChunk(res, id, model, index, delta, finishReason = null) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index, delta, finish_reason: finishReason }],
  })}\n\n`);
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
