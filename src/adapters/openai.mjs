import http from 'node:http';
import https from 'node:https';

import { AdapterEventError } from './events.mjs';

const EFFORT_LADDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
const rejectedEfforts = new Map();

function nextEffortDown(effort) {
  const index = EFFORT_LADDER.indexOf(effort);
  return index === -1 || index === EFFORT_LADDER.length - 1 ? null : EFFORT_LADDER[index + 1];
}

export function createOpenAIAdapter({ providerIdleTimeoutMs }) {
  return Object.freeze({
    kind: 'openai',
    forward(context) {
      return forwardOpenAI({ ...context, providerIdleTimeoutMs });
    },
  });
}

function applyAuthPolicy({ target, headers, apiKey, policy }) {
  if (!apiKey || policy.type === 'none') return;
  if (policy.type === 'bearer') {
    headers.authorization = `Bearer ${apiKey}`;
  } else if (policy.type === 'x-api-key') {
    headers[policy.header || 'x-api-key'] = apiKey;
  } else if (policy.type === 'api-key') {
    target.searchParams.set(policy.query || 'key', apiKey);
  }
}

function forwardOpenAI({ req, res, payload, route, onEvent, providerIdleTimeoutMs, signal }) {
  const { provider, model } = route;
  const responses = route.endpointFamily === 'responses';
  const target = new URL(`${provider.baseUrl.replace(/\/$/, '')}/${responses ? 'responses' : 'chat/completions'}`);
  const client = target.protocol === 'https:' ? https : http;
  const outbound = responses ? toResponsesPayload(payload, route.wireModel) : { ...payload, model: route.wireModel };

  const configured = model.reasoningEffort || provider.reasoningEffort;
  if (!responses && configured && outbound.reasoning_effort === undefined) {
    const rejected = rejectedEfforts.get(`${provider.id}:${model.model}`) || new Set();
    let effort = configured;
    while (effort && rejected.has(effort)) effort = nextEffortDown(effort);
    if (effort) outbound.reasoning_effort = effort;
  }
  const body = Buffer.from(JSON.stringify(outbound), 'utf8');
  const headers = {
    accept: req.headers.accept || 'application/json',
    ...(provider.headers || {}),
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    host: target.host,
  };
  applyAuthPolicy({ target, headers, apiKey: provider.apiKey, policy: route.authPolicy });

  onEvent({ type: 'route', provider: provider.id, model: model.model, adapter: 'openai' });

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
      if (!responses && providerRes.statusCode === 400 && outbound.reasoning_effort) {
      const key = `${provider.id}:${model.model}`;
      const rejected = rejectedEfforts.get(key) || new Set();
      rejected.add(outbound.reasoning_effort);
      rejectedEfforts.set(key, rejected);

      const fallback = nextEffortDown(outbound.reasoning_effort);
      onEvent({
        type: 'notice',
        provider: provider.id,
        message: `${model.model} rejected reasoning effort "${outbound.reasoning_effort}"`
          + (fallback ? `, retrying with "${fallback}"` : ', retrying without it'),
      });
      providerRes.resume();
      if (!signal?.aborted && !res.destroyed) {
        return forwardOpenAI({ req, res, payload, route, onEvent, providerIdleTimeoutMs, signal });
      }
      return;
    }

    if (responses && providerRes.statusCode >= 200 && providerRes.statusCode < 300
      && String(providerRes.headers['content-type'] || '').includes('text/event-stream')) {
      relayResponsesStream(providerRes, res, route.wireModel, {
        onEvent,
        provider: provider.id,
      });
    } else {
      res.writeHead(providerRes.statusCode, providerRes.headers);
      providerRes.pipe(res);
    }
    endOnBrokenSource(providerRes, res, (message) => {
      if (signal?.aborted || res.destroyed || res.writableEnded) return;
      const truncated = new AdapterEventError(message, { category: 'truncated', retryable: true });
      onEvent({ type: 'error', provider: provider.id, message, error: truncated.toEvent().error });
    });
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

function relayResponsesStream(source, res, model, { onEvent, provider }) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let buffer = '';
  let finished = false;
  let emittedText = '';
  const toolCalls = new Map();
  const toolAliases = new Map();
  const writeChunk = (id, delta, finishReason = null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
  };
  const releaseSource = () => {
    if (!source.destroyed) source.destroy();
  };
  const fail = (message, options = {}) => {
    if (finished) return;
    finished = true;
    const error = new AdapterEventError(message, {
      category: 'malformed-response',
      retryable: false,
      ...options,
    });
    onEvent({ type: 'error', provider, error: error.toEvent().error });
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify({ error: error.toEvent().error })}\n\n`);
      res.end('data: [DONE]\n\n');
    }
    releaseSource();
  };
  const validateToolCalls = () => {
    for (const [callId, call] of toolCalls) {
      if (!call.name) throw new Error(`Responses tool call "${callId}" is missing a function name.`);
      try {
        JSON.parse(call.arguments || '{}');
      } catch {
        throw new Error(`Responses tool call "${callId}" produced malformed arguments.`);
      }
    }
  };
  const finish = (id = 'response') => {
    if (finished) return;
    try {
      validateToolCalls();
    } catch (error) {
      fail(error.message);
      return;
    }
    finished = true;
    writeChunk(id, {}, toolCalls.size ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
    releaseSource();
  };
  const addTool = (event) => {
    const item = event.item;
    const callId = item.call_id || item.id;
    if (typeof callId !== 'string' || !callId || typeof item.name !== 'string' || !item.name) {
      throw new Error('Responses function call items require a call ID and function name.');
    }
    const existing = toolCalls.get(callId) || toolAliases.get(callId);
    if (existing) {
      if (existing.name !== item.name) {
        throw new Error(`Responses tool call "${callId}" changed its function name.`);
      }
      if (typeof item.id === 'string' && item.id) toolAliases.set(item.id, existing);
      return existing;
    }
    const call = {
      index: toolCalls.size,
      name: item.name,
      arguments: typeof item.arguments === 'string' ? item.arguments : '',
    };
    toolCalls.set(callId, call);
    toolAliases.set(callId, call);
    if (typeof item.id === 'string' && item.id) toolAliases.set(item.id, call);
    writeChunk(event.response?.id || 'response', {
      tool_calls: [{
        index: call.index,
        id: callId,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }],
    });
    return call;
  };
  const appendToolArguments = (event, complete) => {
    const callId = event.call_id || event.item_id;
    const call = toolAliases.get(callId);
    if (!call) throw new Error('Responses tool argument events require a known call ID.');
    const incoming = complete ? event.arguments : event.delta;
    if (typeof incoming !== 'string') {
      throw new Error(`Responses tool call "${callId}" emitted non-string arguments.`);
    }
    let fragment = incoming;
    if (complete) {
      if (incoming.startsWith(call.arguments)) fragment = incoming.slice(call.arguments.length);
      else if (call.arguments) {
        throw new Error(`Responses tool call "${callId}" completed with inconsistent arguments.`);
      }
    }
    if (fragment) {
      call.arguments += fragment;
      writeChunk(event.response?.id || 'response', {
        tool_calls: [{ index: call.index, function: { arguments: fragment } }],
      });
    }
    if (complete) {
      try {
        JSON.parse(call.arguments || '{}');
      } catch {
        throw new Error(`Responses tool call "${callId}" produced malformed arguments.`);
      }
    }
  };
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop();
    for (const frame of frames) {
      const lines = frame.split(/\r?\n/).filter((entry) => entry.startsWith('data:'));
      if (!lines.length || finished) continue;
      const data = lines.map((line) => line.slice(5).trimStart()).join('\n').trim();
      if (data === '[DONE]') {
        finish();
        continue;
      }
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      const id = event.response?.id || 'response';
      try {
        if (event.type === 'response.output_text.delta') {
          const text = typeof event.delta === 'string' ? event.delta : '';
          emittedText += text;
          writeChunk(id, { content: text });
        } else if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
          const suffix = event.text.startsWith(emittedText) ? event.text.slice(emittedText.length) : event.text;
          if (suffix) {
            emittedText += suffix;
            writeChunk(id, { content: suffix });
          }
        } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          addTool(event);
        } else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
          const call = addTool(event);
          appendToolArguments({ ...event, call_id: event.item.call_id || event.item.id, arguments: event.item.arguments || call.arguments }, true);
        } else if (event.type === 'response.function_call_arguments.delta') {
          appendToolArguments(event, false);
        } else if (event.type === 'response.function_call_arguments.done') {
          appendToolArguments(event, true);
        } else if (event.type === 'response.completed' || event.type === 'response.done') {
          finish(id);
        } else if (event.type === 'response.failed') {
          fail(
            event.response?.error?.message || 'The provider failed to complete the response.',
            { category: 'upstream', retryable: false },
          );
        } else if (event.type === 'response.incomplete') {
          const reason = event.response?.incomplete_details?.reason;
          fail(
            reason
              ? `The provider returned an incomplete response: ${reason}.`
              : 'The provider returned an incomplete response.',
            { category: 'truncated', retryable: true },
          );
        } else if (event.type === 'error') {
          fail(
            event.error?.message || event.message || 'The provider stream failed.',
            { category: 'upstream', retryable: Boolean(event.error?.retryable) },
          );
        }
      } catch (error) {
        fail(error.message);
      }
    }
  });
  source.on('end', () => {
    if (!finished) finish();
  });
}

function toResponsesPayload(payload, wireModel) {
  const outbound = { model: wireModel };
  const input = payload.input ?? payload.messages;
  if (typeof input === 'string') outbound.input = input;
  else if (Array.isArray(input)) outbound.input = toResponsesInput(input);
  if (typeof payload.instructions === 'string') outbound.instructions = payload.instructions;
  if (typeof payload.stream === 'boolean') outbound.stream = payload.stream;
  if (Array.isArray(payload.tools)) outbound.tools = payload.tools.map(toResponsesTool);
  const toolChoice = toResponsesToolChoice(payload.tool_choice);
  if (toolChoice !== undefined) outbound.tool_choice = toolChoice;
  if (typeof payload.parallel_tool_calls === 'boolean') {
    outbound.parallel_tool_calls = payload.parallel_tool_calls;
  }
  const maxOutputTokens = payload.max_output_tokens ?? payload.max_completion_tokens ?? payload.max_tokens;
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) {
    outbound.max_output_tokens = maxOutputTokens;
  }
  if (typeof payload.store === 'boolean') outbound.store = payload.store;
  if (typeof payload.previous_response_id === 'string') {
    outbound.previous_response_id = payload.previous_response_id;
  }
  if (Array.isArray(payload.include)) {
    outbound.include = payload.include.filter((entry) => typeof entry === 'string');
  }
  if (typeof payload.truncation === 'string') outbound.truncation = payload.truncation;
  if (typeof payload.user === 'string') outbound.user = payload.user;
  return outbound;
}

function toResponsesInput(messages) {
  return messages.flatMap((message, index) => {
    if (message?.type === 'function_call') return canonicalFunctionCall(message, index);
    if (message?.type === 'function_call_output') return canonicalFunctionOutput(message);
    if (message?.role === 'tool') {
      return canonicalFunctionOutput({
        call_id: message.tool_call_id,
        output: message.content,
      });
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message?.role)) return [];
    const items = [];
    const content = canonicalMessageContent(message.role, message.content, message.refusal);
    if (content.length) items.push({ role: message.role, content });
    if (message.role === 'assistant' && message.function_call != null) {
      items.push(canonicalFunctionCall({
        call_id: message.tool_call_id || message.id || `call_${index}`,
        name: message.function_call.name,
        arguments: message.function_call.arguments,
      }, index));
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        items.push(canonicalFunctionCall({
          call_id: call?.id,
          name: call?.function?.name,
          arguments: call?.function?.arguments,
        }, index));
      }
    }
    return items;
  });
}

function canonicalMessageContent(role, content, refusal) {
  const parts = [];
  const addText = (text) => {
    if (typeof text !== 'string') return;
    parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text });
  };
  if (typeof content === 'string') {
    addText(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (['text', 'input_text', 'output_text'].includes(part.type)) {
        addText(part.text);
      } else if (role === 'user' && part.type === 'image_url') {
        const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (typeof imageUrl === 'string') {
          parts.push({
            type: 'input_image',
            image_url: imageUrl,
            ...(['low', 'high', 'auto'].includes(part.image_url?.detail) ? { detail: part.image_url.detail } : {}),
          });
        }
      } else if (role === 'user' && part.type === 'input_image') {
        if (typeof part.image_url === 'string') {
          parts.push({
            type: 'input_image',
            image_url: part.image_url,
            ...(['low', 'high', 'auto'].includes(part.detail) ? { detail: part.detail } : {}),
          });
        } else if (typeof part.file_id === 'string') {
          parts.push({
            type: 'input_image',
            file_id: part.file_id,
            ...(['low', 'high', 'auto'].includes(part.detail) ? { detail: part.detail } : {}),
          });
        }
      } else if (role === 'assistant' && part.type === 'refusal' && typeof part.refusal === 'string') {
        parts.push({ type: 'refusal', refusal: part.refusal });
      }
    }
  }
  if (role === 'assistant' && typeof refusal === 'string') {
    parts.push({ type: 'refusal', refusal });
  }
  return parts;
}

function canonicalFunctionCall(call, index) {
  if (typeof call.call_id !== 'string' || !call.call_id) {
    throw invalidResponsesRequest(`Responses function call ${index + 1} is missing a call ID.`);
  }
  if (typeof call.name !== 'string' || !call.name) {
    throw invalidResponsesRequest(`Responses function call "${call.call_id}" is missing a function name.`);
  }
  let args;
  if (typeof call.arguments === 'string') args = call.arguments;
  else {
    try {
      args = JSON.stringify(call.arguments ?? {});
    } catch {
      throw invalidResponsesRequest(`Responses function call "${call.call_id}" has invalid arguments.`);
    }
  }
  try {
    JSON.parse(args);
  } catch {
    throw invalidResponsesRequest(`Responses function call "${call.call_id}" has malformed arguments.`);
  }
  return {
    type: 'function_call',
    call_id: call.call_id,
    name: call.name,
    arguments: args,
  };
}

function canonicalFunctionOutput(item) {
  if (typeof item.call_id !== 'string' || !item.call_id) {
    throw invalidResponsesRequest('Responses tool output is missing a call ID.');
  }
  let output = item.output ?? '';
  if (Array.isArray(output)) {
    output = output
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  } else if (typeof output !== 'string') {
    output = JSON.stringify(output);
  }
  return { type: 'function_call_output', call_id: item.call_id, output };
}

function toResponsesTool(tool) {
  const fn = tool?.type === 'function' && tool.function ? tool.function : tool;
  if (tool?.type !== 'function' || typeof fn?.name !== 'string' || !fn.name) {
    throw invalidResponsesRequest('Responses function tools require a function name.');
  }
  return {
    type: 'function',
    name: fn.name,
    ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
    ...(fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)
      ? { parameters: fn.parameters } : {}),
    ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
  };
}

function toResponsesToolChoice(choice) {
  if (['auto', 'none', 'required'].includes(choice)) return choice;
  if (choice?.type === 'function') {
    const name = choice.name || choice.function?.name;
    if (typeof name !== 'string' || !name) {
      throw invalidResponsesRequest('Responses function tool choice requires a function name.');
    }
    return { type: 'function', name };
  }
  return undefined;
}

function invalidResponsesRequest(message) {
  return new AdapterEventError(message, {
    category: 'invalid-request',
    status: 400,
    retryable: false,
  });
}

function endOnBrokenSource(source, res, report) {
  let finished = false;
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    report(reason);
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  source.on('error', (error) => finish(`stream interrupted: ${error.message}`));
  source.on('aborted', () => finish('stream aborted by the remote end'));
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
