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
 */
export function createRouter({ catalog, upstream: resolver, onEvent = () => {}, adapters = defaultAdapters }) {
  const readCatalog = typeof catalog === 'function' ? catalog : () => catalog;

  return http.createServer((req, res) => {
    collectBody(req)
      .then(async (body) => {
        const origin = await resolver.resolve(req.headers.authorization);
        return handle({ req, res, body, catalog: await readCatalog(), upstream: new URL(origin), onEvent, adapters });
      })
      .catch((error) => {
        onEvent({ type: 'error', message: error.message });
        respondJson(res, 502, { error: { message: `copilot-byok router: ${error.message}` } });
      });
  });
}

async function handle({ req, res, body, catalog, upstream, onEvent, adapters }) {
  if (req.method === 'GET' && isModelsPath(req.url)) {
    return injectModels({ req, res, body, catalog, upstream, onEvent });
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
      return adapter.forward({ req, res, payload: parsed, route, onEvent });
    }
  }

  return passthrough({ req, res, body, upstream, onEvent });
}

function isModelsPath(url) {
  return /^\/models(\?|$)/.test(url || '');
}

// ------------------------------------------------------------------ GET /models

function injectModels({ req, res, body, catalog, upstream, onEvent }) {
  const headers = { ...req.headers, host: upstream.host };
  delete headers['accept-encoding']; // the response must be readable to be extended

  const upstreamReq = https.request(
    { hostname: upstream.hostname, port: upstream.port || 443, path: req.url, method: 'GET', headers },
    (upstreamRes) => {
      readAll(upstreamRes, MAX_MODELS_BYTES).then((raw) => {
        const merged = mergeModels(raw.toString('utf8'), catalog.entries);
        onEvent({
          type: 'models',
          status: upstreamRes.statusCode,
          injected: merged.injected,
        });

        const outHeaders = { ...upstreamRes.headers };
        delete outHeaders['content-encoding'];
        delete outHeaders['content-length'];
        res.writeHead(upstreamRes.statusCode, outHeaders);
        res.end(merged.payload);
      }).catch((error) => {
        onEvent({ type: 'error', message: `GET /models: ${error.message}` });
        res.writeHead(502).end();
      });
    }
  );

  upstreamReq.on('error', (error) => {
    onEvent({ type: 'error', message: `GET /models: ${error.message}` });
    res.writeHead(502).end();
  });
  upstreamReq.end(body);
}

/** Appends the BYOK entries, leaving GitHub's response untouched if it is not the expected JSON. */
export function mergeModels(payload, entries) {
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return { payload, injected: 0 };
  }

  const list = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(list)) return { payload, injected: 0 };

  const known = new Set(list.map((model) => model?.id));
  let injected = 0;
  for (const entry of entries) {
    if (known.has(entry.id)) continue;
    list.push(entry);
    injected += 1;
  }

  return { payload: JSON.stringify(json), injected };
}

// ------------------------------------------------------------------ passthrough

function passthrough({ req, res, body, upstream, onEvent }) {
  const headers = { ...req.headers, host: upstream.host };
  const upstreamReq = https.request(
    { hostname: upstream.hostname, port: upstream.port || 443, path: req.url, method: req.method, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      endOnBrokenSource(upstreamRes, res, (message) => {
        onEvent({ type: 'error', path: req.url, message });
      });
    }
  );

  upstreamReq.on('error', (error) => {
    onEvent({ type: 'error', path: req.url, message: error.message });
    res.writeHead(502).end();
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
  const finish = (reason) => {
    report(reason);
    if (!res.writableEnded) res.end();
  };

  source.on('error', (error) => finish(`stream interrupted: ${error.message}`));
  source.on('aborted', () => finish('stream aborted by the remote end'));
}

function collectBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`request body exceeded the ${maxBytes}-byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readAll(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(new Error(`response exceeded the ${maxBytes}-byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
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
