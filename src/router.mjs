// Local proxy sitting between Copilot CLI and the GitHub Copilot API.
//
//   copilot --COPILOT_API_URL--> router --+--> api.<tier>.githubcopilot.com  (untouched)
//                                          \--> BYOK provider (OpenAI-compatible)
//
// It does three things and nothing else:
//   1. GET /models            appends the BYOK entries to GitHub's list
//   2. POST with a byok-* model  routes to the provider, mapping the id to the real name
//   3. everything else        passes through to GitHub, byte for byte
//
// No TLS interception: the CLI talks in the clear to 127.0.0.1 and the router opens
// its own ordinary HTTPS connection to GitHub.

import http from 'node:http';
import https from 'node:https';

import { AdapterEventError } from './adapters/events.mjs';
import { createAnthropicAdapter } from './adapters/anthropic.mjs';
import { createOpenAIAdapter } from './adapters/openai.mjs';
import { createAdapterRegistry, UnsupportedAdapterError } from './adapters/registry.mjs';
import { isByokModelId } from './catalog.mjs';

const MAX_MODELS_BYTES = 8 * 1024 * 1024;

// Prompts with attachments are large, but not unbounded: this keeps a runaway
// client from growing the router's memory without limit.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// A provider that accepts the connection and then goes silent would otherwise hang
// the turn indefinitely. Generous, because reasoning models legitimately take minutes.
const PROVIDER_IDLE_TIMEOUT_MS = Number(process.env.COPILOT_BYOK_PROVIDER_TIMEOUT_MS) || 600_000;
const defaultAdapters = createAdapterRegistry([
  createAnthropicAdapter({ providerIdleTimeoutMs: PROVIDER_IDLE_TIMEOUT_MS }),
  createOpenAIAdapter({ providerIdleTimeoutMs: PROVIDER_IDLE_TIMEOUT_MS }),
]);

/**
 * @param {object}   options
 * @param {object|function} options.catalog  Result of buildCatalog(), or a function
 *   returning it. A function is re-evaluated per request, so keys added during the
 *   session (for example through /byok) take effect without a restart.
 * @param {object}   options.upstream  Resolver from createUpstreamResolver().
 * @param {function} [options.onEvent] Diagnostic callback: ({type, ...}) => void
 * @param {object} [options.adapters] Adapter registry with a resolve(kind) method.
 * @param {'append'|'replace'} [options.modelCatalogMode] How GET /models combines catalogs.
 */
export function createRouter({ catalog, upstream: resolver, onEvent = () => {}, adapters = defaultAdapters, transport = https, modelCatalogMode = 'append' }) {
  const readCatalog = typeof catalog === 'function' ? catalog : () => catalog;
  const controllers = new Set();

  const server = http.createServer((req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    const cleanup = () => {
      controllers.delete(controller);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
      res.removeListener('finish', cleanup);
    };
    const abort = () => controller.abort();
    controller.signal.addEventListener('abort', cleanup, { once: true });
    req.once('aborted', abort);
    res.once('close', abort);
    res.once('finish', cleanup);
    collectBody(req, MAX_BODY_BYTES, controller.signal)
      .then(async (body) => {
        if (controller.signal.aborted) return;
        const origin = await resolver.resolve(req.headers.authorization);
        return handle({ req, res, body, catalog: await readCatalog(), upstream: new URL(origin), onEvent, adapters, signal: controller.signal, transport, modelCatalogMode });
      })
      .catch((error) => {
        if (controller.signal.aborted || res.destroyed) return;
        onEvent({ type: 'error', error: error instanceof AdapterEventError ? error.toEvent().error : { category: 'upstream', message: 'Upstream request failed.', retryable: true } });
        respondJson(res, error instanceof AdapterEventError && error.status || 502, { error: { message: error instanceof AdapterEventError ? error.message : 'Upstream request failed.' } });
      });
  });

  let shutdown;
  server.shutdown = () => {
    if (!shutdown) {
      shutdown = new Promise((resolve, reject) => {
        for (const controller of controllers) controller.abort();
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
    return shutdown;
  };

  return server;
}

async function handle({ req, res, body, catalog, upstream, onEvent, adapters, signal, transport, modelCatalogMode }) {
  if (req.method === 'GET' && isModelsPath(req.url)) {
    return injectModels({ req, res, body, catalog, upstream, onEvent, signal, transport, modelCatalogMode });
  }

  if (req.method === 'POST' && body.length) {
    const parsed = tryParseJson(body);
    if (parsed && isByokModelId(parsed.model)) {
      const route = catalog.routes.get(parsed.model);
      if (!route) {
        return respondJson(res, 404, {
          error: { message: `Unknown BYOK model: ${parsed.model}. Restart copilot-byok to rebuild the catalog.` },
        });
      }
      let adapter;
      try {
        adapter = adapters.resolve(route.adapterKind);
      } catch (error) {
        if (!(error instanceof UnsupportedAdapterError)) throw error;
        onEvent({ type: 'error', code: error.code, adapter: error.kind, message: error.message });
        return respondJson(res, 422, {
          error: { code: error.code, adapter: error.kind, message: error.message },
        });
      }
      return adapter.forward({ req, res, payload: parsed, route, onEvent, signal });
    }
  }

  return passthrough({ req, res, body, upstream, onEvent, signal, transport });
}

function isModelsPath(url) {
  return /^\/models(\?|$)/.test(url || '');
}

// ------------------------------------------------------------------ GET /models

function injectModels({ req, res, body, catalog, upstream, onEvent, signal, transport = https, modelCatalogMode = 'append' }) {
  const headers = { ...req.headers, host: upstream.host };
  delete headers['accept-encoding']; // the response must be readable to be extended

  const upstreamReq = transport.request(
    { hostname: upstream.hostname, port: upstream.port || 443, path: req.url, method: 'GET', headers, signal },
    (upstreamRes) => {
      readAll(upstreamRes, MAX_MODELS_BYTES).then((raw) => {
        if (signal?.aborted || res.destroyed) return;
        const merged = mergeModels(raw.toString('utf8'), catalog.entries, { mode: modelCatalogMode });
        onEvent({
          type: 'models',
          status: upstreamRes.statusCode,
          injected: merged.injected,
          removed: merged.removed || 0,
        });

        const outHeaders = { ...upstreamRes.headers };
        delete outHeaders['content-encoding'];
        delete outHeaders['content-length'];
        res.writeHead(upstreamRes.statusCode, outHeaders);
        res.end(merged.payload);
      }).catch((error) => {
        if (signal?.aborted || res.destroyed) return;
        const safe = error instanceof AdapterEventError ? error : new AdapterEventError('Upstream model catalog request failed.', { category: 'upstream', retryable: true, cause: error });
        onEvent({ type: 'error', path: '/models', error: safe.toEvent().error });
        respondJson(res, safe.status || 502, { error: { message: 'Upstream model catalog request failed.' } });
      });
    }
  );

  upstreamReq.on('error', (error) => {
    if (signal?.aborted || res.destroyed) return;
    const category = error.code === 'ABORT_ERR' ? 'cancelled' : 'upstream';
    const safe = new AdapterEventError(category === 'cancelled' ? 'Request cancelled.' : 'Upstream model catalog request failed.', { category, retryable: category === 'upstream', cause: error });
    onEvent({ type: 'error', path: '/models', error: safe.toEvent().error });
    respondJson(res, safe.status || 502, { error: { message: 'Upstream model catalog request failed.' } });
  });
  upstreamReq.end(body);
}

/** Combines the upstream catalog with entries, or replaces it with routed entries. */
export function mergeModels(payload, entries, { mode = 'append' } = {}) {
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return { payload, injected: 0 };
  }

  const list = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(list)) return { payload, injected: 0 };

  if (mode === 'replace') {
    const removed = list.length;
    list.splice(0, list.length, ...entries);
    return { payload: JSON.stringify(json), injected: entries.length, removed };
  }

  const known = new Set(list.map((model) => model?.id));
  let injected = 0;
  for (const entry of entries) {
    if (known.has(entry.id)) continue;
    list.push(entry);
    injected += 1;
  }

  return { payload: JSON.stringify(json), injected, removed: 0 };
}

// ------------------------------------------------------------------ passthrough

function passthrough({ req, res, body, upstream, onEvent, signal, transport = https }) {
  const headers = { ...req.headers, host: upstream.host };
  const upstreamReq = transport.request(
    { hostname: upstream.hostname, port: upstream.port || 443, path: req.url, method: req.method, headers, signal },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      endOnBrokenSource(upstreamRes, res, (message) => {
        onEvent({ type: 'error', path: req.url, error: { category: 'truncated', message, retryable: true } });
      });
    }
  );

  upstreamReq.on('error', (error) => {
    if (signal?.aborted || res.destroyed) return;
    const category = error.code === 'ABORT_ERR' ? 'cancelled' : 'upstream';
    const safe = new AdapterEventError(category === 'cancelled' ? 'Request cancelled.' : 'Upstream request failed.', { category, retryable: category === 'upstream', cause: error });
    onEvent({ type: 'error', path: req.url, error: safe.toEvent().error });
    respondJson(res, 502, { error: { message: 'Upstream request failed.' } });
  });

  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });

  upstreamReq.end(body);
}

// ---------------------------------------------------------------------- utilities

/**
 * Closes the response when the source stream breaks. Node's pipe() leaves the
 * destination open on a source error, and an IncomingMessage without an error
 * listener discards the error entirely — together that means a silent hang.
 */
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

function collectBody(req, maxBytes = MAX_BODY_BYTES, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const abort = () => settle(reject, new AdapterEventError('Request cancelled.', { category: 'cancelled' }));
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.resume();
        settle(reject, new AdapterEventError(`Request body exceeded the ${maxBytes}-byte limit.`, { category: 'invalid-request', status: 413 }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(resolve, Buffer.concat(chunks));
    const onError = (error) => settle(reject, error);
    signal?.addEventListener('abort', abort, { once: true });
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
  });
}

function readAll(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('aborted', onAborted);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        settle(reject, new AdapterEventError(`Response exceeded the ${maxBytes}-byte limit.`, { category: 'invalid-request', status: 502 }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(resolve, Buffer.concat(chunks));
    const onError = (error) => settle(reject, error);
    const onAborted = () => settle(reject, new AdapterEventError(
      total > maxBytes ? `Response exceeded the ${maxBytes}-byte limit.` : 'Upstream response was truncated.',
      { category: total > maxBytes ? 'invalid-request' : 'truncated', status: total > maxBytes ? 502 : undefined, retryable: total <= maxBytes },
    ));
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('aborted', onAborted);
  });
}

function tryParseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
