// Starts the router on an ephemeral loopback port and launches Copilot CLI pointed at
// it through COPILOT_API_URL. The router shuts down when Copilot exits.

import spawn from 'cross-spawn';

import { buildCatalog } from './catalog.mjs';
import { discoverModels } from './discovery.mjs';
import { readCache } from './model-cache.mjs';
import { createRouter } from './router.mjs';
import { createUpstreamResolver } from './upstream.mjs';
import { resolveCopilotBin } from './copilot-bin.mjs';
import { sanitizeCopilotEnvironment } from './process-env.mjs';

/** Usable providers: they have models and a credential (or need none). */
export function selectActiveProviders(providers) {
  return providers.filter((provider) => {
    if (provider.enabled === false) return false;
    if (!provider.models?.length) return false;
    if (provider.authRequired === false) return true;
    return Boolean(provider.apiKey || provider.bearerToken);
  });
}

/**
 * Replaces each provider's shipped model list with what it actually serves right
 * now. Providers are queried in parallel; one that fails keeps its curated list,
 * so a slow or unreachable provider never empties the picker.
 */
export async function resolveLiveModels(providers, { onEvent = () => {}, discoverImpl = discoverModels, env = process.env } = {}) {
  const diskCache = await readCache(env).catch(() => ({}));

  return Promise.all(providers.map(async (provider) => {
    // Only ask providers we can actually authenticate with. Querying the rest
    // would add a round trip and a 401 in the log for every unconfigured entry.
    if (!hasCredential(provider)) return provider;

    const { models, source, reason } = await discoverImpl(provider, { diskCache, env });
    if (source === 'remembered') {
      onEvent({
        type: 'notice',
        provider: provider.id,
        message: `model discovery failed (${reason}); using the list this key returned last time`,
      });
    } else if (source === 'catalog' && reason) {
      onEvent({ type: 'error', provider: provider.id, message: `model discovery fell back to the shipped list: ${reason}` });
    } else {
      onEvent({ type: 'discovery', provider: provider.id, count: models.length, source });
    }
    return { ...provider, models };
  }));
}

export function isQueryable(provider) {
  return hasCredential(provider);
}

function hasCredential(provider) {
  if (provider.enabled === false) return false;
  if (provider.authRequired === false) return true;
  return Boolean(provider.apiKey || provider.bearerToken);
}

export function startRouter({ providers, upstreamOrigin, onEvent, port = 0, host = '127.0.0.1', reload, modelCatalogMode = 'append' }) {
  const build = (list) => buildCatalog(selectActiveProviders(list).map((provider) => ({
    ...provider,
    apiKey: provider.bearerToken || provider.apiKey,
  })));

  const active = selectActiveProviders(providers);
  let catalog = build(providers);
  let lastReload = 0;

  // Keys can appear mid-session (the /byok extension writes to the key store), so
  // the catalog is rebuilt on demand rather than frozen at startup. Rebuilds are
  // throttled because this runs on the request path.
  const currentCatalog = async () => {
    if (!reload) return catalog;
    const now = Date.now();
    if (now - lastReload < 2000) return catalog;
    lastReload = now;
    try {
      catalog = build(await reload());
    } catch (error) {
      onEvent?.({ type: 'error', message: `catalog reload failed: ${error.message}` });
    }
    return catalog;
  };

  const upstream = createUpstreamResolver({ explicit: upstreamOrigin });
  const server = createRouter({ catalog: currentCatalog, upstream, onEvent, modelCatalogMode });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        catalog,
        currentCatalog,
        providers: active,
        url: `http://${host}:${address.port}`,
        close: () => new Promise((done) => {
          // Copilot keeps connections alive: without closing them explicitly the
          // process would never terminate.
          if (typeof server.shutdown === 'function') {
            server.shutdown().then(done, done);
          } else {
            server.closeAllConnections();
            server.close(done);
          }
        }),
      });
    });
  });
}

export function runCopilotWithRouter({ routerUrl, copilotArgs, env, config, io }) {
  const copilotBin = resolveCopilotBin({ env: io.env });

  // Provider credentials are stripped from the child environment, so the /byok
  // extension cannot see which ones came from environment variables. This passes
  // the ids only — never the values — so it can report their state correctly.
  const fromEnvironment = (config?.providers || [])
    .filter((provider) => (provider.apiKeyEnv || []).some((name) => io.env[name]))
    .map((provider) => provider.id)
    .join(',');

  const childEnv = sanitizeCopilotEnvironment(
    io.env,
    {
      ...env,
      COPILOT_API_URL: routerUrl,
      ...(fromEnvironment ? { COPILOT_BYOK_ENV_PROVIDERS: fromEnvironment } : {}),
    },
    collectSecretEnvNames(config)
  );

  return new Promise((resolve, reject) => {
    const child = spawn(copilotBin, copilotArgs, { env: childEnv, shell: false, stdio: 'inherit' });
    child.on('error', (error) => reject(describeSpawnError(error, copilotBin)));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function collectSecretEnvNames(config) {
  return (config?.providers || []).flatMap((provider) => [
    ...toArray(provider.apiKeyEnv),
    ...toArray(provider.bearerTokenEnv),
  ]);
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function describeSpawnError(error, copilotBin) {
  if (error?.code !== 'ENOENT') return error;
  return new Error(
    `Could not launch GitHub Copilot CLI at "${copilotBin}". Install it with "npm install -g @github/copilot" or set COPILOT_BIN.`,
    { cause: error }
  );
}
