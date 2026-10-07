import type {BrowserContext, Frame, Page} from 'playwright';

// Non-disruptive Context snapshots: cookies, per-origin localStorage/IndexedDB and per-tab
// sessionStorage, read only from pages and frames that are already open.
//
// Never use Playwright's native context.storageState() on a live, headful browser: for every origin the
// Context ever visited with no open page it opens a temporary page, navigates it there and closes it.
// Each one raises its window (seen 2026-10-07: every Arena node window in turn, half a second apart) and
// it reads unpartitioned storage that the pages' cross-site iframes never use.
//
// Semantics (moved from APanel context-snapshot.ts, the contract `non-disruptive-context-snapshot`):
// - a previous snapshot seeds the capture: origins read now replace it, origins not open now are carried,
//   origins whose read failed keep their old value and are listed as failed;
// - captures of one Context share one in-flight read; the cache lives on the Context (Symbol.for keys
//   shared with APanel's resident copy, so both see the same state in one Browser);
// - nothing is created, navigated, activated or closed.
//
// contextSnapshotKit() is self-contained (it captures nothing from this module), so its source can be
// injected into a running Browser host that loaded an older package: `(${contextSnapshotKit})()`.

export type SnapshotDatabase = {
  name: string;
  version: number;
  stores: Array<{
    name: string; autoIncrement: boolean; keyPath?: string; keyPathArray?: string[];
    indexes: Array<{name: string; multiEntry: boolean; unique: boolean; keyPath?: string; keyPathArray?: string[]}>;
    records: Array<{keyEncoded?: unknown; valueEncoded: unknown}>;
  }>;
};
export type SnapshotStorageState = {
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
  origins: Array<{origin: string; localStorage: Array<{name: string; value: string}>; indexedDB?: SnapshotDatabase[]}>;
};
export type ContextSnapshotState = SnapshotStorageState & {
  capture: {
    version: 1;
    capturedAt: string;
    mode: 'existing-frames-only';
    scope?: 'top-level-pages';
    freshOrigins: string[];
    carriedOrigins: string[];
    failedOrigins: string[];
    emptyPartitionedOrigins?: string[];
    failures: Array<{origin: string; reason: string}>;
    limitations: string[];
  };
};
export type ContextSnapshotPage = {
  url: string;
  pageName: string;
  sessionStorage: Array<[string, string]>;
  sessionStorageByOrigin: Array<{origin: string; entries: Array<[string, string]>}>;
  primary?: boolean;
};
export type ContextSnapshotKit = ReturnType<typeof contextSnapshotKit>;

export function contextSnapshotKit() {
  type StorageState = SnapshotStorageState;
  type OriginState = StorageState['origins'][number];
  type Cache = {latest?: ContextSnapshotState; seed?: StorageState; inFlight?: Promise<ContextSnapshotState>};

  // Storage-only policy: never removes live browser values, cookies or account metadata. The AWS Console
  // key broke the Console header on real restores when kept (APanel snapshot-storage-policy-v1).
  const isAwsConsoleOrigin = (origin: string): boolean => {
    try {
      const host = new URL(origin).hostname;
      return host === 'console.aws.amazon.com' || host.endsWith('.console.aws.amazon.com');
    } catch {
      return false;
    }
  };
  const excludedStorageKeys = (origin: string, kind: 'local' | 'session'): string[] =>
    isAwsConsoleOrigin(origin) && kind === 'session' ? ['FeatureFlagManager.modelSummaries'] : [];
  const keepStorageKey = (origin: string, kind: 'local' | 'session', key: string) => !excludedStorageKeys(origin, kind).includes(key);

  const cacheKey = Symbol.for('apanel.context-snapshot.top-level.v1');
  const legacyKey = Symbol.for('apanel.context-snapshot.v1');
  const pageCacheKey = Symbol.for('apanel.context-snapshot.page.v1');
  const readonlyPageKey = Symbol.for('apanel.snapshot.readonly-page');

  const cacheFor = (context: BrowserContext): Cache => {
    const owner = context as BrowserContext & Record<symbol, Cache | undefined>;
    const legacy = owner[legacyKey];
    return (owner[cacheKey] ??= {seed: legacy?.latest || legacy?.seed});
  };

  const seedContextSnapshot = (context: BrowserContext, previous?: StorageState): void => {
    if (!previous) return;
    const cache = cacheFor(context);
    // Restoration seeds are immutable baselines, never newer than a live capture.
    if (!cache.seed) cache.seed = structuredClone(previous);
    else {
      const knownSeed = new Set(cache.seed.origins.map((item) => item.origin));
      for (const origin of previous.origins) if (!knownSeed.has(origin.origin)) cache.seed.origins.push(structuredClone(origin));
    }
    if (cache.latest) {
      const known = new Set(cache.latest.origins.map((item) => item.origin));
      for (const origin of previous.origins) {
        if (known.has(origin.origin)) continue;
        cache.latest.origins.push(structuredClone(origin));
        cache.latest.capture.carriedOrigins.push(origin.origin);
      }
    }
  };

  // Executed only inside an existing frame. Self-contained for Playwright serialization.
  async function readFrameStorage(expectedOrigin: string, selection?: {database?: string; store?: string; skipLocal?: boolean; excludedLocalKeys?: string[]}) {
    if (location.origin !== expectedOrigin) throw new Error('Snapshot origin changed');
    const localStorage = (selection?.skipLocal ? [] : Object.keys(window.localStorage).filter((key) => !selection?.excludedLocalKeys?.includes(key)))
      .map((name) => ({name, value: window.localStorage.getItem(name) || ''}));
    type Visitor = {visited: Map<object, number>; lastId: number};
    const encode = (value: any, visitor: Visitor): any => {
      if (value === undefined) return {v: 'undefined'};
      if (value === null) return {v: 'null'};
      if (typeof value === 'number') {
        if (Number.isNaN(value)) return {v: 'NaN'};
        if (value === Infinity) return {v: 'Infinity'};
        if (value === -Infinity) return {v: '-Infinity'};
        if (Object.is(value, -0)) return {v: '-0'};
        return value;
      }
      if (typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'bigint') return {bi: String(value)};
      if (value instanceof Date) return {d: value.toJSON()};
      if (value instanceof RegExp) return {r: {p: value.source, f: value.flags}};
      if (value instanceof Error) return {e: {n: value.name, m: value.message, s: value.stack || ''}};
      const base64 = (buffer: ArrayBufferLike, offset = 0, length = buffer.byteLength) => {
        const bytes = new Uint8Array(buffer, offset, length);
        let text = '';
        for (const byte of bytes) text += String.fromCharCode(byte);
        return btoa(text);
      };
      if (value instanceof ArrayBuffer) return {ab: {b: base64(value)}};
      const arrays: Array<[string, any]> = [
        ['i8', Int8Array], ['ui8', Uint8Array], ['ui8c', Uint8ClampedArray],
        ['i16', Int16Array], ['ui16', Uint16Array], ['i32', Int32Array], ['ui32', Uint32Array],
        ['f32', Float32Array], ['f64', Float64Array], ['bi64', BigInt64Array], ['bui64', BigUint64Array],
      ];
      for (const [kind, constructor] of arrays) {
        if (value instanceof constructor) return {ta: {b: base64(value.buffer, value.byteOffset, value.byteLength), k: kind}};
      }
      const prior = visitor.visited.get(value);
      if (prior) return {ref: prior};
      const id = ++visitor.lastId;
      visitor.visited.set(value, id);
      if (Array.isArray(value)) return {a: value.map((item) => encode(item, visitor)), id};
      // Never silently turn Blob/Map/Set/File/DataView into {} and call it a backup.
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new Error('Snapshot contains a value unsupported by the restore format');
      }
      return {o: Object.keys(value).map((k) => ({k, v: encode(value[k], visitor)})), id};
    };
    const request = <T,>(operation: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(new Error('IndexedDB snapshot read failed'));
    });
    const databases = await indexedDB.databases();
    const indexedDBState: SnapshotDatabase[] = [];
    for (const info of databases) {
      if (selection?.database !== undefined && info.name !== selection.database) continue;
      if (info.name === undefined || info.version === undefined) throw new Error('IndexedDB identity missing');
      const opening = indexedDB.open(info.name, info.version);
      // If deleted between enumeration and open, abort rather than create a database.
      opening.onupgradeneeded = () => opening.transaction?.abort();
      const database = await request(opening);
      database.onversionchange = () => database.close();
      try {
        const names = Array.from(database.objectStoreNames).filter((name) => selection?.store === undefined || name === selection.store);
        const stores: SnapshotDatabase['stores'] = [];
        if (names.length) {
          const transaction = database.transaction(names, 'readonly');
          const done = new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = transaction.onerror = () => reject(new Error('IndexedDB snapshot transaction failed'));
          });
          void done.catch(() => {});
          // Queue all requests synchronously to avoid transaction auto-commit gaps.
          const reads = names.map((name) => {
            const store = transaction.objectStore(name);
            return {store, keys: request(store.getAllKeys()), values: request(store.getAll())};
          });
          const results = await Promise.all(reads.map(async ({store, keys, values}) => {
            const [allKeys, allValues] = await Promise.all([keys, values]);
            return {
              name: store.name,
              autoIncrement: store.autoIncrement,
              ...(typeof store.keyPath === 'string' ? {keyPath: store.keyPath} : {}),
              ...(Array.isArray(store.keyPath) ? {keyPathArray: store.keyPath} : {}),
              indexes: Array.from(store.indexNames).map((name) => {
                const index = store.index(name);
                return {name, multiEntry: index.multiEntry, unique: index.unique,
                  ...(typeof index.keyPath === 'string' ? {keyPath: index.keyPath} : {keyPathArray: index.keyPath as string[]})};
              }),
              records: allValues.map((value, index) => ({
                ...(store.keyPath === null ? {keyEncoded: encode(allKeys[index], {visited: new Map(), lastId: 0})} : {}),
                valueEncoded: encode(value, {visited: new Map(), lastId: 0}),
              })),
            };
          }));
          await done;
          stores.push(...results);
        }
        indexedDBState.push({name: info.name, version: info.version, stores});
      } finally {
        database.close();
      }
    }
    if (location.origin !== expectedOrigin) throw new Error('Snapshot origin changed');
    return {origin: expectedOrigin, localStorage, indexedDB: indexedDBState};
  }

  const collect = async (context: BrowserContext, previous?: StorageState): Promise<ContextSnapshotState> => {
    const origins = new Map<string, OriginState>((previous?.origins || []).map((item) => [item.origin,
      structuredClone({...item, localStorage: item.localStorage.filter((entry) => keepStorageKey(item.origin, 'local', entry.name))})]));
    const frames = new Map<string, Frame[]>();
    for (const page of context.pages()) {
      if (page.isClosed() || (page as unknown as Record<symbol, unknown>)[readonlyPageKey]) continue;
      for (const frame of [page.mainFrame()]) {
        if (frame.isDetached()) continue;
        try {
          const url = new URL(frame.url());
          if (!['http:', 'https:'].includes(url.protocol)) continue;
          const group = frames.get(url.origin) || [];
          group.push(frame);
          frames.set(url.origin, group);
        } catch {
          // An opaque frame is not representable by the restore format.
        }
      }
    }
    const freshOrigins: string[] = [];
    const failedOrigins: string[] = [];
    const failures: Array<{origin: string; reason: string}> = [];
    const cookies = await context.cookies();
    // Bound per-context read concurrency; different contexts remain independent.
    const pending = [...frames];
    const worker = async () => {
      for (;;) {
        const next = pending.shift();
        if (!next) return;
        const [origin, candidates] = next;
        let captured: OriginState | undefined;
        let failureReason = 'No readable existing frame';
        for (const frame of candidates) {
          try {
            // A keepNames bundle may inject __name into nested functions: supply a local equivalent in
            // the serialized scope instead of relying on a helper in the page.
            captured = await frame.evaluate(`(() => {
              const __name = value => value;
              return (${readFrameStorage.toString()})(${JSON.stringify(origin)}, ${JSON.stringify({excludedLocalKeys: excludedStorageKeys(origin, 'local')})});
            })()`) as OriginState;
            if (new URL(frame.url()).origin !== origin) {
              captured = undefined;
              continue;
            }
            break;
          } catch (error) {
            failureReason = error instanceof Error ? error.message : String(error);
          }
        }
        if (captured) {
          // Keep explicit empty origins as tombstones so old data is not resurrected.
          origins.set(origin, captured);
          freshOrigins.push(origin);
        } else {
          failedOrigins.push(origin);
          failures.push({origin, reason: failureReason});
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(3, pending.length)}, worker));
    return {
      cookies,
      origins: [...origins.values()],
      capture: {
        version: 1,
        capturedAt: new Date().toISOString(),
        mode: 'existing-frames-only',
        scope: 'top-level-pages',
        freshOrigins: freshOrigins.sort(),
        carriedOrigins: [...origins.keys()].filter((origin) => !freshOrigins.includes(origin)).sort(),
        failedOrigins: failedOrigins.sort(),
        emptyPartitionedOrigins: [],
        failures,
        limitations: ['logical-session-not-browser-memory', 'unobserved-historical-origins-not-discoverable', 'iframe-storage-out-of-scope'],
      },
    };
  };

  /** No Page creation/navigation/activation, and no call to native storageState. */
  const captureContextStorageState = async (context: BrowserContext, previous?: StorageState): Promise<ContextSnapshotState> => {
    seedContextSnapshot(context, previous);
    const cache = cacheFor(context);
    if (!cache.inFlight) {
      cache.inFlight = collect(context, cache.latest || cache.seed).then((result) => {
        // A restoration seed may arrive while the read is in flight. Merge only missing origins, so fresh
        // values and explicit empty tombstones still win.
        const known = new Set(result.origins.map((item) => item.origin));
        for (const origin of cache.seed?.origins || []) {
          if (known.has(origin.origin)) continue;
          result.origins.push(structuredClone(origin));
          result.capture.carriedOrigins.push(origin.origin);
        }
        result.origins = result.origins.map((origin) => ({...origin, localStorage: origin.localStorage.filter((item) => keepStorageKey(origin.origin, 'local', item.name))}));
        cache.latest = result;
        return result;
      }).finally(() => {
        cache.inFlight = undefined;
      });
    }
    return structuredClone(await cache.inFlight);
  };

  const isTransientContextPageUrl = (value: unknown): boolean => {
    try {
      const url = new URL(String(value || ''));
      return url.hostname === 'hooks.stripe.com' && url.pathname.startsWith('/3d_secure_2/hosted');
    } catch {
      return false;
    }
  };

  const seedContextPageSnapshot = (page: Page, state: Pick<ContextSnapshotPage, 'url' | 'sessionStorage'> & Partial<ContextSnapshotPage>): void => {
    const owner = page as unknown as Record<symbol, Map<string, Array<[string, string]>> | undefined>;
    if (owner[pageCacheKey]) return;
    const seed = new Map((state.sessionStorageByOrigin || []).map((item) => [item.origin, structuredClone(item.entries)]));
    try {
      seed.set(new URL(state.url).origin, structuredClone(state.sessionStorage));
    } catch {
      // opaque
    }
    owner[pageCacheKey] = seed;
  };

  const captureContextOpenPages = async (context: BrowserContext, primary: Page, onlyPages?: Page[]): Promise<ContextSnapshotPage[]> =>
    Promise.all(context.pages().filter((page) =>
      !page.isClosed() && !(page as unknown as Record<symbol, unknown>)[readonlyPageKey] && (!onlyPages || onlyPages.includes(page)) &&
      (page === primary || !isTransientContextPageUrl(page.url()))
    ).map(async (page) => {
      const url = page.url();
      const owner = page as unknown as Record<symbol, Map<string, Array<[string, string]>> | undefined>;
      const current = new Map(owner[pageCacheKey] || []);
      const byOrigin = new Map<string, Frame>();
      for (const frame of [page.mainFrame()]) {
        if (frame.isDetached() || !/^https?:/i.test(frame.url())) continue;
        byOrigin.set(new URL(frame.url()).origin, frame);
      }
      for (const [origin, frame] of byOrigin) {
        try {
          const entries = await frame.evaluate(({expected, excluded}) => {
            if (location.origin !== expected) throw new Error('Session snapshot origin changed');
            return Object.keys(window.sessionStorage).filter((key) => key !== '__apanel_session_snapshot_restored_v1' && !excluded.includes(key))
              .map((key) => [key, window.sessionStorage.getItem(key) || ''] as [string, string]);
          }, {expected: origin, excluded: excludedStorageKeys(origin, 'session')});
          current.set(origin, entries);
        } catch {
          // Do not replace unknown sessionStorage with []. Let the caller keep the prior snapshot.
          throw new Error('Context sessionStorage snapshot incomplete; keep the previous snapshot');
        }
      }
      if (page.isClosed() || page.url() !== url) throw new Error('Context page navigated during snapshot; keep previous snapshot');
      owner[pageCacheKey] = current;
      return {url, pageName: String((page as Page & {name?: string}).name || ''),
        sessionStorage: current.get(new URL(url).origin) || [],
        sessionStorageByOrigin: [...current].filter(([origin]) => origin === new URL(url).origin).map(([origin, entries]) => ({origin, entries})),
        ...(page === primary ? {primary: true} : {})};
    }));

  const captureContextSessionState = async (page: Page, previous?: StorageState) => {
    const context = page.context();
    const [storageState, openPages] = await Promise.all([
      captureContextStorageState(context, previous), captureContextOpenPages(context, page),
    ]);
    const primary = openPages.find((item) => item.primary);
    if (!primary) throw new Error('Context snapshot primary page is missing');
    return {storageState, openPages, resumeUrl: primary.url, sessionStorage: primary.sessionStorageByOrigin};
  };

  /** Per Context: native storageState() on it goes to the non-disruptive capture. */
  const installContextSnapshotCompatibility = (context: BrowserContext, previous?: StorageState): void => {
    seedContextSnapshot(context, previous);
    const owner = context as BrowserContext & {storageState: (options?: {path?: string}) => Promise<unknown>};
    owner.storageState = async (options?: {path?: string}) => {
      if (options?.path) throw new Error('Context snapshot path writes belong to the session repository');
      return captureContextStorageState(context);
    };
  };

  /** For a Browser host: every Context (their prototype, so later ones too) captures non-disruptively. */
  const installContextSnapshotHost = (contexts: readonly BrowserContext[]): number => {
    const prototypes = new Set(contexts.map((context) => Object.getPrototypeOf(context)));
    for (const prototype of prototypes) {
      prototype.storageState = async function (this: BrowserContext, options?: {path?: string}) {
        if (options?.path) throw new Error('Context snapshot path writes belong to the session repository');
        return captureContextStorageState(this);
      };
    }
    for (const context of contexts) installContextSnapshotCompatibility(context);
    return contexts.length;
  };

  return {
    captureContextStorageState,
    captureContextOpenPages,
    captureContextSessionState,
    seedContextSnapshot,
    seedContextPageSnapshot,
    installContextSnapshotCompatibility,
    installContextSnapshotHost,
    isTransientContextPageUrl,
    excludedStorageKeys,
    keepStorageKey,
    readFrameStorage,
  };
}

const kit = contextSnapshotKit();
export const captureContextStorageState = kit.captureContextStorageState;
export const captureContextOpenPages = kit.captureContextOpenPages;
export const captureContextSessionState = kit.captureContextSessionState;
export const seedContextSnapshot = kit.seedContextSnapshot;
export const seedContextPageSnapshot = kit.seedContextPageSnapshot;
export const installContextSnapshotCompatibility = kit.installContextSnapshotCompatibility;
export const installContextSnapshotHost = kit.installContextSnapshotHost;
export const isTransientContextPageUrl = kit.isTransientContextPageUrl;
export const excludedStorageKeys = kit.excludedStorageKeys;
export const keepStorageKey = kit.keepStorageKey;
export const readFrameStorage = kit.readFrameStorage;

/** Source of contextSnapshotKit for injecting into a running Browser host: `(${CONTEXT_SNAPSHOT_KIT_SOURCE})()`. */
export const CONTEXT_SNAPSHOT_KIT_SOURCE = contextSnapshotKit.toString();
