export const DEFAULT_ADAPTER_KIND = 'openai';

export class UnsupportedAdapterError extends Error {
  constructor(kind) {
    super(`Unsupported provider adapter "${kind}". Register it before routing requests.`);
    this.name = 'UnsupportedAdapterError';
    this.code = 'unsupported_adapter';
    this.kind = kind;
  }
}

export function createAdapterRegistry(adapters) {
  const registered = new Map();

  for (const adapter of adapters) {
    if (!adapter || typeof adapter.kind !== 'string' || !adapter.kind.length || typeof adapter.forward !== 'function') {
      throw new TypeError('Adapters must provide a non-empty kind and a forward function.');
    }
    if (registered.has(adapter.kind)) {
      throw new TypeError(`Adapter kind "${adapter.kind}" is already registered.`);
    }
    registered.set(adapter.kind, adapter);
  }

  return Object.freeze({
    resolve(kind = DEFAULT_ADAPTER_KIND) {
      const adapter = registered.get(kind);
      if (!adapter) throw new UnsupportedAdapterError(kind);
      return adapter;
    },
  });
}
