import type {APIResponse, BrowserContext, Request, Route} from 'playwright';

export interface SharedContextCacheRequest {
  route: Route;
  request: Request;
  url: string;
  resourceType: string;
}

export interface SharedContextCacheEntry {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  size: number;
  expiresAt: number;
}

export interface SharedContextCacheStats {
  enabled: boolean;
  contexts: number;
  entries: number;
  bytes: number;
  maxBytes: number;
  maxEntries: number;
  inFlight: number;
  lastStoredAt: number | null;
  nextExpiryAt: number | null;
  hits: number;
  misses: number;
  coalesced: number;
  stored: number;
  downloadedBytes: number;
  servedBytes: number;
  blocked: number;
}

export interface SharedContextCacheOptions {
  routePattern?: string | RegExp;
  enabled?: boolean;
  maxBytes?: number;
  maxEntries?: number;
  maxItemBytes?: number;
  ttlMs?: number;
  mainFrameOnly?: boolean;
  shouldBypass?: (value: SharedContextCacheRequest) => boolean;
  shouldBlock?: (value: SharedContextCacheRequest) => boolean;
  shouldCache: (value: SharedContextCacheRequest) => boolean;
  key?: (value: SharedContextCacheRequest) => string;
  shouldStoreResponse?: (
    response: APIResponse,
    value: SharedContextCacheRequest,
  ) => boolean | Promise<boolean>;
  responseHeaders?: (headers: Record<string, string>) => Record<string, string>;
  onError?: (error: unknown, value: SharedContextCacheRequest) => void;
}

export interface SharedContextCache {
  attach(context: BrowserContext): Promise<BrowserContext>;
  setEnabled(enabled: boolean): Promise<SharedContextCacheStats>;
  getStats(): SharedContextCacheStats;
}

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_ITEM_BYTES = 12 * 1024 * 1024;
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

function reusableResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    'content-type',
    'cache-control',
    'etag',
    'last-modified',
    'access-control-allow-origin',
    'cross-origin-resource-policy',
    'timing-allow-origin',
    'x-content-type-options',
  ]) {
    if (headers[name]) result[name] = headers[name];
  }
  return result;
}

function responseIsPublicAndReusable(response: APIResponse): boolean {
  if (response.status() !== 200) return false;
  const headers = response.headers();
  if (headers['set-cookie']) return false;
  return !/(?:^|,)\s*(?:cookie|authorization)\s*(?:,|$)/i.test(headers.vary || '');
}

export function createSharedContextCache(options: SharedContextCacheOptions): SharedContextCache {
  const routePattern = options.routePattern ?? /.*/;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxItemBytes = options.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const mainFrameOnly = options.mainFrameOnly ?? true;
  const cacheKey = options.key ?? (value => `${value.resourceType}:${value.url}`);
  const selectHeaders = options.responseHeaders ?? reusableResponseHeaders;
  const entries = new Map<string, SharedContextCacheEntry>();
  const inFlight = new Map<string, Promise<SharedContextCacheEntry | undefined>>();
  const contexts = new Set<BrowserContext>();
  const handlers = new Map<BrowserContext, (route: Route) => Promise<void>>();
  let enabled = options.enabled ?? true;
  let bytes = 0;
  let lastStoredAt: number | null = null;
  const counters = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    stored: 0,
    downloadedBytes: 0,
    servedBytes: 0,
    blocked: 0,
  };

  function deleteEntry(key: string, entry: SharedContextCacheEntry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    bytes -= entry.size;
  }

  function readEntry(key: string): SharedContextCacheEntry | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      deleteEntry(key, entry);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  function storeEntry(key: string, entry: SharedContextCacheEntry): SharedContextCacheEntry | undefined {
    if (entry.size > maxItemBytes || entry.size > maxBytes) return undefined;
    const previous = entries.get(key);
    if (previous) deleteEntry(key, previous);
    while (entries.size >= maxEntries || bytes + entry.size > maxBytes) {
      const oldest = entries.entries().next().value as [string, SharedContextCacheEntry] | undefined;
      if (!oldest) break;
      deleteEntry(oldest[0], oldest[1]);
    }
    entries.set(key, entry);
    bytes += entry.size;
    counters.stored++;
    lastStoredAt = Date.now();
    counters.downloadedBytes += entry.size;
    return entry;
  }

  async function fetchEntry(value: SharedContextCacheRequest, key: string) {
    const cached = readEntry(key);
    if (cached) {
      counters.hits++;
      counters.servedBytes += cached.size;
      return cached;
    }
    const running = inFlight.get(key);
    if (running) {
      counters.coalesced++;
      const entry = await running;
      if (entry) counters.servedBytes += entry.size;
      return entry;
    }
    counters.misses++;
    const pending = (async () => {
      const response = await value.route.fetch();
      const canStore = options.shouldStoreResponse
        ? await options.shouldStoreResponse(response, value)
        : responseIsPublicAndReusable(response);
      if (!canStore) return undefined;
      const body = await response.body();
      return storeEntry(key, {
        status: response.status(),
        headers: selectHeaders(response.headers()),
        body,
        size: body.byteLength,
        expiresAt: Date.now() + ttlMs,
      });
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  async function handleRoute(route: Route) {
    const request = route.request();
    const value: SharedContextCacheRequest = {
      route,
      request,
      url: request.url(),
      resourceType: request.resourceType(),
    };
    if (options.shouldBypass?.(value)) return route.continue();
    if (options.shouldBlock?.(value)) {
      counters.blocked++;
      return route.abort('blockedbyclient');
    }
    if (mainFrameOnly) {
      try {
        const frame = request.frame();
        if (frame !== frame.page().mainFrame()) return route.continue();
      } catch {
        return route.continue();
      }
    }
    if (request.method() !== 'GET' || !options.shouldCache(value)) return route.continue();
    try {
      const entry = await fetchEntry(value, cacheKey(value));
      if (entry) return route.fulfill({status: entry.status, headers: entry.headers, body: entry.body});
    } catch (error) {
      options.onError?.(error, value);
    }
    return route.continue();
  }

  async function configure(context: BrowserContext, nextEnabled: boolean) {
    const existing = handlers.get(context);
    if (!nextEnabled) {
      if (existing) {
        await context.unroute(routePattern, existing).catch(() => {});
        handlers.delete(context);
      }
      return;
    }
    if (existing) return;
    const handler = (route: Route) => handleRoute(route);
    handlers.set(context, handler);
    await context.route(routePattern, handler);
  }

  async function attach(context: BrowserContext): Promise<BrowserContext> {
    if (!contexts.has(context)) {
      contexts.add(context);
      context.once('close', () => {
        contexts.delete(context);
        handlers.delete(context);
      });
    }
    await configure(context, enabled);
    return context;
  }

  function getStats(): SharedContextCacheStats {
    let nextExpiryAt: number | null = null;
    for (const entry of entries.values()) {
      if (nextExpiryAt === null || entry.expiresAt < nextExpiryAt) nextExpiryAt = entry.expiresAt;
    }
    return {
      enabled,
      contexts: contexts.size,
      entries: entries.size,
      bytes,
      maxBytes,
      maxEntries,
      inFlight: inFlight.size,
      lastStoredAt,
      nextExpiryAt,
      ...counters,
    };
  }

  async function setEnabled(nextEnabled: boolean): Promise<SharedContextCacheStats> {
    enabled = nextEnabled;
    await Promise.all([...contexts].map(context => configure(context, enabled)));
    return getStats();
  }

  return {attach, setEnabled, getStats};
}
