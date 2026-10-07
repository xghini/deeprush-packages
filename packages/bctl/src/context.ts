import type {Browser, BrowserContext, BrowserContextOptions} from 'playwright';
import {
  NATURAL_BROWSER_LOCALE,
  createDefaultBrowserContext,
  defaultBrowserContextOptions,
  type DefaultBrowserContextBehaviorOptions,
} from './default-context.js';

export * from './default-context.js';

export interface BrowserProxyEnvironment {
  ip?: string;
  countryCode?: string;
  country?: string;
  region?: string;
  city?: string;
  timezoneId: string;
  latitude?: number;
  longitude?: number;
  source: 'ipwho.is' | 'api.ip.sb' | 'ipapi.co' | 'cloudflare-trace' | 'fallback';
  detectedAt: string;
}

export const BROWSER_ENVIRONMENT_PROBE_ATTEMPTS = 3;
export const BROWSER_ENVIRONMENT_PROBE_RETRY_MS = 5_000;

const DEFAULT_SUCCESS_CACHE_MS = 5 * 60_000;
const DEFAULT_FALLBACK_CACHE_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_GEOLOCATION_ACCURACY_METERS = 50_000;
type BrowserEnvironmentGlobal = typeof globalThis & {
  __deeprushBctlContextEnvironments?: WeakMap<BrowserContext, BrowserProxyEnvironment>;
};
const browserEnvironmentGlobal = globalThis as BrowserEnvironmentGlobal;
const sharedContextEnvironments = browserEnvironmentGlobal.__deeprushBctlContextEnvironments
  ??= new WeakMap<BrowserContext, BrowserProxyEnvironment>();

const FALLBACK_COUNTRY_BY_TIMEZONE: Record<string, string> = {
  'Asia/Bangkok': 'TH',
  'America/Chicago': 'US',
  'Asia/Hong_Kong': 'HK',
  'Asia/Singapore': 'SG',
  'Asia/Manila': 'PH',
  'Asia/Kuala_Lumpur': 'MY',
  'America/Toronto': 'CA',
  'Asia/Tokyo': 'JP',
  'Australia/Sydney': 'AU',
  'Europe/London': 'GB',
  'America/Mexico_City': 'MX',
};

const FALLBACK_TIMEZONE_BY_COUNTRY: Record<string, string> = {
  TH: 'Asia/Bangkok',
  HK: 'Asia/Hong_Kong',
  SG: 'Asia/Singapore',
  PH: 'Asia/Manila',
  MY: 'Asia/Kuala_Lumpur',
  JP: 'Asia/Tokyo',
  GB: 'Europe/London',
};

type BrowserProxy = NonNullable<BrowserContextOptions['proxy']>;

interface EnvironmentProbe {
  url: string;
  parse(body: string, fallbackTimezone: string): BrowserProxyEnvironment | undefined;
}

function text(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function countryCode(value: unknown): string | undefined {
  const normalized = text(value)?.toUpperCase();
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function normalizeBrowserTimezone(value: unknown, fallback = 'UTC'): string {
  const candidates = [text(value), text(fallback), 'UTC'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      new Intl.DateTimeFormat(NATURAL_BROWSER_LOCALE, {timeZone: candidate}).format();
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return 'UTC';
}

function environment(
  source: BrowserProxyEnvironment['source'],
  fallbackTimezone: string,
  values: Omit<Partial<BrowserProxyEnvironment>, 'source' | 'detectedAt' | 'timezoneId'> & {timezoneId?: unknown},
): BrowserProxyEnvironment | undefined {
  const ip = text(values.ip);
  const code = countryCode(values.countryCode);
  if (!ip || !code) return undefined;
  return {
    ip,
    countryCode: code,
    country: text(values.country),
    region: text(values.region),
    city: text(values.city),
    timezoneId: normalizeBrowserTimezone(values.timezoneId, fallbackTimezone),
    latitude: finiteNumber(values.latitude),
    longitude: finiteNumber(values.longitude),
    source,
    detectedAt: new Date().toISOString(),
  };
}

export function parseIpWhoEnvironment(body: string, fallbackTimezone: string): BrowserProxyEnvironment | undefined {
  try {
    const payload = JSON.parse(body) as Record<string, any>;
    if (payload.success === false) return undefined;
    return environment('ipwho.is', fallbackTimezone, {
      ip: payload.ip,
      countryCode: payload.country_code,
      country: payload.country,
      region: payload.region,
      city: payload.city,
      timezoneId: payload.timezone?.id,
      latitude: payload.latitude,
      longitude: payload.longitude,
    });
  } catch {
    return undefined;
  }
}

export function parseIpApiEnvironment(body: string, fallbackTimezone: string): BrowserProxyEnvironment | undefined {
  try {
    const payload = JSON.parse(body) as Record<string, any>;
    if (payload.error === true) return undefined;
    return environment('ipapi.co', fallbackTimezone, {
      ip: payload.ip,
      countryCode: payload.country_code,
      country: payload.country_name,
      region: payload.region,
      city: payload.city,
      timezoneId: payload.timezone,
      latitude: payload.latitude,
      longitude: payload.longitude,
    });
  } catch {
    return undefined;
  }
}

export function parseIpSbEnvironment(body: string, fallbackTimezone: string): BrowserProxyEnvironment | undefined {
  try {
    const payload = JSON.parse(body) as Record<string, any>;
    return environment('api.ip.sb', fallbackTimezone, {
      ip: payload.ip,
      countryCode: payload.country_code,
      country: payload.country,
      region: payload.region,
      city: payload.city,
      timezoneId: payload.timezone,
      latitude: payload.latitude,
      longitude: payload.longitude,
    });
  } catch {
    return undefined;
  }
}

export function parseCloudflareTraceEnvironment(
  body: string,
  fallbackTimezone: string,
): BrowserProxyEnvironment | undefined {
  const values = Object.fromEntries(
    body
      .split(/\r?\n/)
      .map(line => line.split('='))
      .filter(parts => parts.length === 2)
      .map(([key, value]) => [key!.trim(), value!.trim()]),
  );
  return environment('cloudflare-trace', fallbackTimezone, {
    ip: values.ip,
    countryCode: values.loc,
    timezoneId: FALLBACK_TIMEZONE_BY_COUNTRY[countryCode(values.loc) || ''],
  });
}

const BROWSER_ENVIRONMENT_PROBES: readonly EnvironmentProbe[] = [
  {url: 'https://ipwho.is/', parse: parseIpWhoEnvironment},
  {url: 'https://api.ip.sb/geoip', parse: parseIpSbEnvironment},
  {url: 'https://ipapi.co/json/', parse: parseIpApiEnvironment},
  {url: 'https://www.cloudflare.com/cdn-cgi/trace', parse: parseCloudflareTraceEnvironment},
];

export function fallbackBrowserEnvironment(timezoneId: string): BrowserProxyEnvironment {
  const normalizedTimezone = normalizeBrowserTimezone(timezoneId);
  return {
    timezoneId: normalizedTimezone,
    countryCode: FALLBACK_COUNTRY_BY_TIMEZONE[normalizedTimezone],
    source: 'fallback',
    detectedAt: new Date().toISOString(),
  };
}

export async function probeBrowserEnvironmentWithRetries(options: {
  fallbackTimezone: string;
  read: (url: string) => Promise<string>;
  wait: (milliseconds: number) => Promise<unknown>;
  attempts?: number;
  retryMs?: number;
}): Promise<{environment: BrowserProxyEnvironment; failures: string[]}> {
  const failures: string[] = [];
  const attempts = options.attempts ?? BROWSER_ENVIRONMENT_PROBE_ATTEMPTS;
  const retryMs = options.retryMs ?? BROWSER_ENVIRONMENT_PROBE_RETRY_MS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const probe of BROWSER_ENVIRONMENT_PROBES) {
      try {
        const detected = probe.parse(await options.read(probe.url), options.fallbackTimezone);
        if (detected) return {environment: detected, failures};
        throw new Error('response did not contain a valid IP and country');
      } catch (error) {
        failures.push(
          `attempt ${attempt} ${new URL(probe.url).hostname}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (attempt < attempts) await options.wait(retryMs);
  }
  return {environment: fallbackBrowserEnvironment(options.fallbackTimezone), failures};
}

export interface IpAdaptiveContextManagerOptions {
  locale?: string;
  successCacheMs?: number;
  fallbackCacheMs?: number;
  probeTimeoutMs?: number;
  probeAttempts?: number;
  probeRetryMs?: number;
  geolocationAccuracy?: number;
  defaultContextBehavior?: DefaultBrowserContextBehaviorOptions | false;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface CreateIpAdaptiveContextOptions {
  proxy: BrowserProxy;
  fallbackTimezone?: string;
  contextOptions?: BrowserContextOptions;
  locale?: string;
  geolocationAccuracy?: number;
  defaultContextBehavior?: DefaultBrowserContextBehaviorOptions | false;
}

export interface IpAdaptiveContextResult {
  context: BrowserContext;
  environment: BrowserProxyEnvironment;
}

export interface IpAdaptiveContextManager {
  resolve(browser: Browser, proxy: BrowserProxy, fallbackTimezone?: string): Promise<BrowserProxyEnvironment>;
  create(browser: Browser, options: CreateIpAdaptiveContextOptions): Promise<IpAdaptiveContextResult>;
  rememberEnvironment(context: BrowserContext, environment: BrowserProxyEnvironment): BrowserContext;
  getEnvironment(context: BrowserContext): BrowserProxyEnvironment | undefined;
}

export function browserContextOptionsForEnvironment(
  proxy: BrowserProxy,
  detected: BrowserProxyEnvironment,
  options: BrowserContextOptions = {},
  locale?: string,
  geolocationAccuracy = DEFAULT_GEOLOCATION_ACCURACY_METERS,
): BrowserContextOptions {
  const {
    proxy: _proxy,
    locale: _locale,
    timezoneId: _timezoneId,
    geolocation: _geolocation,
    ...baseOptions
  } = options;
  const hasCoordinates = Number.isFinite(detected.latitude) && Number.isFinite(detected.longitude);
  return defaultBrowserContextOptions({
    ...baseOptions,
    locale,
    timezoneId: detected.timezoneId,
    ...(hasCoordinates
      ? {
          geolocation: {
            latitude: detected.latitude!,
            longitude: detected.longitude!,
            accuracy: geolocationAccuracy,
          },
        }
      : {}),
    proxy,
  }, locale);
}

export function createIpAdaptiveContextManager(
  managerOptions: IpAdaptiveContextManagerOptions = {},
): IpAdaptiveContextManager {
  const locale = managerOptions.locale;
  const successCacheMs = managerOptions.successCacheMs ?? DEFAULT_SUCCESS_CACHE_MS;
  const fallbackCacheMs = managerOptions.fallbackCacheMs ?? DEFAULT_FALLBACK_CACHE_MS;
  const probeTimeoutMs = managerOptions.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probeAttempts = managerOptions.probeAttempts ?? BROWSER_ENVIRONMENT_PROBE_ATTEMPTS;
  const probeRetryMs = managerOptions.probeRetryMs ?? BROWSER_ENVIRONMENT_PROBE_RETRY_MS;
  const geolocationAccuracy = managerOptions.geolocationAccuracy ?? DEFAULT_GEOLOCATION_ACCURACY_METERS;
  const defaultContextBehavior = managerOptions.defaultContextBehavior ?? {};
  const logger = managerOptions.logger ?? console;
  const cache = new Map<string, {expiresAt: number; environment: BrowserProxyEnvironment}>();
  const inFlight = new Map<string, Promise<BrowserProxyEnvironment>>();
  const contextEnvironments = sharedContextEnvironments;

  const proxyKey = (proxy: BrowserProxy) => [proxy.server, proxy.username || '', proxy.password || ''].join('|');

  async function probeFresh(
    browser: Browser,
    proxy: BrowserProxy,
    fallbackTimezone: string,
  ): Promise<BrowserProxyEnvironment> {
    const fallback = fallbackBrowserEnvironment(fallbackTimezone);
    let context: BrowserContext | undefined;
    const failures: string[] = [];
    try {
      context = await browser.newContext(defaultBrowserContextOptions({
        acceptDownloads: false,
        viewport: null,
        locale,
        timezoneId: fallback.timezoneId,
        proxy,
      }, locale));
      const page = await context.newPage();
      const result = await probeBrowserEnvironmentWithRetries({
        fallbackTimezone: fallback.timezoneId,
        attempts: probeAttempts,
        retryMs: probeRetryMs,
        read: async url => {
          const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: probeTimeoutMs,
          });
          if (!response?.ok()) throw new Error(`HTTP ${response?.status() || 0}`);
          return page.locator('body').innerText({timeout: Math.min(2_000, probeTimeoutMs)});
        },
        wait: milliseconds => page.waitForTimeout(milliseconds),
      });
      failures.push(...result.failures);
      return result.environment;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      await context?.close().catch(() => {});
    }
    logger.warn(
      `[Browser Environment] proxy probe failed; using timezone fallback ${fallback.timezoneId}: ${failures.join('; ')}`,
    );
    return fallback;
  }

  async function resolve(
    browser: Browser,
    proxy: BrowserProxy,
    fallbackTimezone = 'UTC',
  ): Promise<BrowserProxyEnvironment> {
    const key = proxyKey(proxy);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.environment;
    const running = inFlight.get(key);
    if (running) return running;
    const probe = probeFresh(browser, proxy, fallbackTimezone)
      .then(detected => {
        cache.set(key, {
          environment: detected,
          expiresAt: Date.now() + (detected.source === 'fallback' ? fallbackCacheMs : successCacheMs),
        });
        logger.log(
          `[Browser Environment] proxy=${proxy.server} ip=${detected.ip || 'unknown'} country=${detected.countryCode || 'unknown'} timezone=${detected.timezoneId} locale=${locale} source=${detected.source}`,
        );
        return detected;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, probe);
    return probe;
  }

  async function create(browser: Browser, options: CreateIpAdaptiveContextOptions): Promise<IpAdaptiveContextResult> {
    const detected = await resolve(browser, options.proxy, options.fallbackTimezone);
    const context = await createDefaultBrowserContext(
      browser,
      browserContextOptionsForEnvironment(
        options.proxy,
        detected,
        options.contextOptions,
        options.locale ?? locale,
        options.geolocationAccuracy ?? geolocationAccuracy,
      ),
      options.defaultContextBehavior ?? defaultContextBehavior,
    );
    rememberEnvironment(context, detected);
    return {context, environment: detected};
  }

  function rememberEnvironment(context: BrowserContext, detected: BrowserProxyEnvironment): BrowserContext {
    contextEnvironments.set(context, detected);
    context.once('close', () => contextEnvironments.delete(context));
    return context;
  }

  return {
    resolve,
    create,
    rememberEnvironment,
    getEnvironment: context => contextEnvironments.get(context),
  };
}

const defaultIpAdaptiveContextManager = createIpAdaptiveContextManager();

export function createIpAdaptiveContext(
  browser: Browser,
  options: CreateIpAdaptiveContextOptions,
): Promise<IpAdaptiveContextResult> {
  return defaultIpAdaptiveContextManager.create(browser, options);
}

export function resolveProxyEnvironment(
  browser: Browser,
  proxy: BrowserProxy,
  fallbackTimezone?: string,
): Promise<BrowserProxyEnvironment> {
  return defaultIpAdaptiveContextManager.resolve(browser, proxy, fallbackTimezone);
}

export function getBrowserContextEnvironment(context: BrowserContext): BrowserProxyEnvironment | undefined {
  return defaultIpAdaptiveContextManager.getEnvironment(context);
}
