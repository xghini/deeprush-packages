import {randomBytes} from 'node:crypto';
import type {Browser, BrowserContext, BrowserContextOptions, Page} from 'playwright';

export const NATURAL_BROWSER_LOCALE = 'en-US';
/** Browser 创建链使用的规范 HTTP Accept-Language 值；默认 Context 不注入语言。 */
export const NATURAL_BROWSER_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
/** 兼容既有调用方；Browser 的 Accept-Language 只维护上面的唯一规范值。 */
export const NATURAL_BROWSER_ACCEPT_LANGUAGE_HEADER = NATURAL_BROWSER_ACCEPT_LANGUAGE;
/** Chromium --accept-lang 使用不带 HTTP 权重的语言偏好列表，由规范头值派生。 */
export const NATURAL_BROWSER_LANGUAGE_PREFERENCES = NATURAL_BROWSER_ACCEPT_LANGUAGE
  .split(',')
  .map(value => value.split(';', 1)[0]!)
  .join(',');
export const PROXY_SAFE_WEBRTC_ARGS = [
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--enforce-webrtc-ip-permission-check',
] as const;
export const DEFAULT_CHROMIUM_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--window-size=1600,900',
  ...PROXY_SAFE_WEBRTC_ARGS,
  `--lang=${NATURAL_BROWSER_LOCALE}`,
  `--accept-lang=${NATURAL_BROWSER_LANGUAGE_PREFERENCES}`,
] as const;
export const DEFAULT_CHROMIUM_IGNORE_ARGS = [
  '--enable-automation',
  // Playwright 默认关闭此保护；忽略该启动参数即可恢复 Chrome 原生 IPC 洪泛限流。
  '--disable-ipc-flooding-protection',
] as const;

export interface DefaultBrowserContextBehaviorOptions {
  fingerprint?: boolean;
  fingerprintSeed?: string;
  normalizeChromeIdentity?: boolean;
  identityProbeUrl?: string;
}

interface UserAgentBrandVersion {
  brand: string;
  version: string;
}

interface ChromeIdentityProfile {
  userAgent: string;
  navigatorPlatform: string;
  brands: UserAgentBrandVersion[];
  fullVersionList: UserAgentBrandVersion[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
}

const DEFAULT_IDENTITY_PROBE_URL = 'http://127.0.0.1:3175/stats';
const stableFingerprintNoisePromises = new WeakMap<BrowserContext, Promise<void>>();
const chromeIdentityContexts = new WeakSet<BrowserContext>();
const chromeIdentityPages = new WeakMap<Page, Promise<void>>();
const chromeIdentityProfilePromises = new WeakMap<Browser, Map<string, Promise<ChromeIdentityProfile>>>();

export function defaultBrowserContextOptions(
  options: BrowserContextOptions = {},
  locale?: string,
): BrowserContextOptions {
  const {
    acceptDownloads,
    deviceScaleFactor,
    extraHTTPHeaders: requestedExtraHTTPHeaders,
    locale: requestedLocale,
    viewport,
    ...baseOptions
  } = options;
  const resolvedViewport = viewport === undefined ? null : viewport;
  const resolvedLocale = requestedLocale || locale;
  return {
    ...baseOptions,
    acceptDownloads: acceptDownloads ?? true,
    viewport: resolvedViewport,
    ...(resolvedViewport === null || deviceScaleFactor === undefined ? {} : {deviceScaleFactor}),
    ...(resolvedLocale ? {locale: resolvedLocale} : {}),
    ...(requestedExtraHTTPHeaders === undefined
      ? {}
      : {extraHTTPHeaders: {...requestedExtraHTTPHeaders}}),
  };
}

function installStableFingerprintNoise({seed}: {seed: string}) {
  const hashString = (value: string) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  };
  const mix = (value: number) => {
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value ^= value >>> 16;
    return value >>> 0;
  };
  const baseSeed = hashString(seed) || 0x9e3779b9;
  const randomSequence = (salt: number) => {
    let state = mix(baseSeed ^ salt) || 0x6d2b79f5;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
  };
  const nativeFunctionToString = Function.prototype.toString;
  const nativeFunctionSources = new WeakMap<Function, string>();
  const rememberNativeFunctionSource = <T extends Function>(replacement: T, original: Function): T => {
    nativeFunctionSources.set(replacement, Reflect.apply(nativeFunctionToString, original, []));
    return replacement;
  };
  const replaceMethod = (
    prototype: object | undefined,
    name: string,
    invoke: (
      original: (...args: any[]) => any,
      thisArg: unknown,
      args: any[],
    ) => unknown,
  ) => {
    if (!prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== 'function') return;
    const replacement = rememberNativeFunctionSource(
      new Proxy(descriptor.value, {
        apply(original, thisArg, args) {
          return invoke(original, thisArg, args);
        },
      }),
      descriptor.value,
    );
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value: replacement,
    });
  };

  const optionalFontVariants = [
    null,
    'PingFang HK',
    'Zapf Dingbats',
    'Mishafi',
    'Webdings',
  ] as const;
  const fontRandom = randomSequence(0x464f4e54);
  const optionalFontAlias = optionalFontVariants[fontRandom() % optionalFontVariants.length];
  if (optionalFontAlias) {
    try {
      const face = new FontFace(
        optionalFontAlias,
        'local("Arial")',
        {style: 'normal', weight: 'normal'},
      );
      (document.fonts as unknown as {add(face: FontFace): unknown}).add(face);
      void face.load().catch(() => {});
    } catch {
      // Font Loading API support is optional; preserve page startup when unavailable.
    }
  }

  const canvas2dPrototype = globalThis.CanvasRenderingContext2D?.prototype;
  const canvasRandom = randomSequence(0x43414e56);
  // Same server-validated interval as before ([1/64, 7/64]) on a 16x finer grid: 7 buckets -> 97.
  // A distinct seed used to collide on Canvas roughly 1 in 7 times purely from quantization.
  const canvasTextShift = (16 + (canvasRandom() % 97)) / 1024;
  replaceMethod(canvas2dPrototype, 'fillText', (original, thisArg, args) => {
    if (args.length < 3) return Reflect.apply(original, thisArg, args);
    const shiftedArgs = [...args];
    shiftedArgs[1] = Number(args[1]) + canvasTextShift;
    return Reflect.apply(original, thisArg, shiftedArgs);
  });

  const changedAudioChannels = new WeakMap<object, Set<number>>();
  replaceMethod(globalThis.AudioBuffer?.prototype, 'getChannelData', (original, thisArg, args) => {
    const samples = Reflect.apply(original, thisArg, args) as Float32Array;
    const channelNumber = args[0];
    const normalizedChannel = Number(channelNumber) >>> 0;
    const audioBuffer = thisArg as object;
    let changedChannels = changedAudioChannels.get(audioBuffer);
    if (!changedChannels) {
      changedChannels = new Set<number>();
      changedAudioChannels.set(audioBuffer, changedChannels);
    }
    if (changedChannels.has(normalizedChannel) || samples.length === 0) return samples;

    const random = randomSequence(
      mix(Math.imul(samples.length, 0x9e3779b1) ^ Math.imul(normalizedChannel + 1, 0x85ebca6b) ^ 0x41554449),
    );
    for (let blockStart = 0; blockStart < samples.length; blockStart += 64) {
      const index = blockStart + (random() % Math.min(64, samples.length - blockStart));
      const current = samples[index]!;
      if (!Number.isFinite(current)) continue;
      const delta = (1 + (random() % 7)) * 0.000001;
      const direction = current < 0 ? -1 : 1;
      const outward = Math.fround(current + direction * delta);
      samples[index] = Math.abs(outward) <= 1
        ? outward
        : Math.fround(current - direction * delta);
    }
    changedChannels.add(normalizedChannel);
    return samples;
  });

  const wrapUniform2f = (prototype: object | undefined, salt: number) => {
    const random = randomSequence(salt);
    // Same interval as before ([1/128, 4/128]) on a 32x finer grid: 4 buckets -> 97.
    const uniformShift = (32 + (random() % 97)) / 4096;
    replaceMethod(prototype, 'uniform2f', (original, thisArg, args) => {
      if (args.length < 3) return Reflect.apply(original, thisArg, args);
      const shiftedArgs = [...args];
      shiftedArgs[1] = Number(args[1]) - uniformShift;
      return Reflect.apply(original, thisArg, shiftedArgs);
    });
  };
  wrapUniform2f(globalThis.WebGLRenderingContext?.prototype, 0x57474c31);
  wrapUniform2f(globalThis.WebGL2RenderingContext?.prototype, 0x57474c32);

  const toStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
  if (toStringDescriptor && typeof toStringDescriptor.value === 'function') {
    const replacement = rememberNativeFunctionSource(
      new Proxy(nativeFunctionToString, {
        apply(original, thisArg, args) {
          const nativeSource = typeof thisArg === 'function'
            ? nativeFunctionSources.get(thisArg)
            : undefined;
          return nativeSource ?? Reflect.apply(original, thisArg, args);
        },
      }),
      nativeFunctionToString,
    );
    Object.defineProperty(Function.prototype, 'toString', {
      ...toStringDescriptor,
      value: replacement,
    });
  }
}

export async function applyStableFingerprintNoiseToContext(
  context: BrowserContext,
  seed = randomBytes(16).toString('hex'),
): Promise<BrowserContext> {
  let setupPromise = stableFingerprintNoisePromises.get(context);
  if (!setupPromise) {
    const argument = JSON.stringify({seed}).replaceAll('<', '\\u003c');
    const content = `(() => {
      const __name = (target, value) => Object.defineProperty(target, 'name', {value, configurable: true});
      return (${installStableFingerprintNoise.toString()})(${argument});
    })();`;
    setupPromise = context.addInitScript({content}).then(() => undefined);
    stableFingerprintNoisePromises.set(context, setupPromise);
  }
  await setupPromise;
  return context;
}

async function readChromeIdentityProfile(
  browser: Browser,
  identityProbeUrl: string,
): Promise<ChromeIdentityProfile> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    try {
      await page.goto(identityProbeUrl, {waitUntil: 'domcontentloaded', timeout: 10_000});
    } catch {
      // navigator.userAgent remains readable on about:blank if the optional local probe is unavailable.
    }
    const nativeIdentity = await page.evaluate(async () => {
      const uaData = (navigator as any).userAgentData;
      const highEntropy = uaData
        ? await uaData.getHighEntropyValues([
            'architecture',
            'bitness',
            'model',
            'platformVersion',
            'uaFullVersion',
            'fullVersionList',
            'wow64',
          ])
        : undefined;
      return {
        userAgent: navigator.userAgent,
        navigatorPlatform: navigator.platform,
        brands: uaData?.brands || [],
        mobile: uaData?.mobile || false,
        platform: uaData?.platform || '',
        highEntropy,
      };
    });
    const browserVersion = browser.version();
    const majorVersion = browserVersion.split('.')[0]!;
    const brands = [...nativeIdentity.brands] as UserAgentBrandVersion[];
    const fullVersionList = [...(nativeIdentity.highEntropy?.fullVersionList || [])] as UserAgentBrandVersion[];
    if (brands.length > 0 && !brands.some(item => item.brand === 'Google Chrome')) {
      const chromiumIndex = brands.findIndex(item => item.brand === 'Chromium');
      brands.splice(chromiumIndex < 0 ? brands.length : chromiumIndex, 0, {
        brand: 'Google Chrome',
        version: majorVersion,
      });
    }
    if (fullVersionList.length > 0 && !fullVersionList.some(item => item.brand === 'Google Chrome')) {
      const chromiumIndex = fullVersionList.findIndex(item => item.brand === 'Chromium');
      fullVersionList.splice(chromiumIndex < 0 ? fullVersionList.length : chromiumIndex, 0, {
        brand: 'Google Chrome',
        version: browserVersion,
      });
    }
    return {
      userAgent: nativeIdentity.userAgent,
      navigatorPlatform: nativeIdentity.navigatorPlatform,
      brands,
      fullVersionList,
      fullVersion: nativeIdentity.highEntropy?.uaFullVersion || browserVersion,
      platform: nativeIdentity.platform,
      platformVersion: nativeIdentity.highEntropy?.platformVersion || '',
      architecture: nativeIdentity.highEntropy?.architecture || '',
      model: nativeIdentity.highEntropy?.model || '',
      mobile: nativeIdentity.mobile,
      bitness: nativeIdentity.highEntropy?.bitness || '',
      wow64: nativeIdentity.highEntropy?.wow64 || false,
    };
  } finally {
    await context.close();
  }
}

function getChromeIdentityProfile(browser: Browser, identityProbeUrl: string) {
  let profiles = chromeIdentityProfilePromises.get(browser);
  if (!profiles) {
    profiles = new Map();
    chromeIdentityProfilePromises.set(browser, profiles);
  }
  let profilePromise = profiles.get(identityProbeUrl);
  if (!profilePromise) {
    profilePromise = readChromeIdentityProfile(browser, identityProbeUrl);
    profiles.set(identityProbeUrl, profilePromise);
  }
  return profilePromise;
}

async function applyChromeIdentityToPage(browser: Browser, page: Page, identityProbeUrl: string) {
  let setupPromise = chromeIdentityPages.get(page);
  if (!setupPromise) {
    setupPromise = (async () => {
      const profile = await getChromeIdentityProfile(browser, identityProbeUrl);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: profile.userAgent,
        acceptLanguage: NATURAL_BROWSER_ACCEPT_LANGUAGE,
        platform: profile.navigatorPlatform,
        ...(profile.brands.length > 0 && profile.platform
          ? {
              userAgentMetadata: {
                brands: profile.brands,
                fullVersionList: profile.fullVersionList,
                fullVersion: profile.fullVersion,
                platform: profile.platform,
                platformVersion: profile.platformVersion,
                architecture: profile.architecture,
                model: profile.model,
                mobile: profile.mobile,
                bitness: profile.bitness,
                wow64: profile.wow64,
              },
            }
          : {}),
      });
    })();
    chromeIdentityPages.set(page, setupPromise);
  }
  await setupPromise;
}

export async function applyChromeIdentityToContext(
  browser: Browser,
  context: BrowserContext,
  identityProbeUrl = DEFAULT_IDENTITY_PROBE_URL,
): Promise<BrowserContext> {
  if (chromeIdentityContexts.has(context)) return context;
  chromeIdentityContexts.add(context);
  const originalNewPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await originalNewPage();
    await applyChromeIdentityToPage(browser, page, identityProbeUrl);
    return page;
  };
  context.on('page', page => {
    void applyChromeIdentityToPage(browser, page, identityProbeUrl).catch(error => {
      console.warn(
        `[Browser Fingerprint] page UA-CH normalization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
  await Promise.all(context.pages().map(page => applyChromeIdentityToPage(browser, page, identityProbeUrl)));
  return context;
}

export async function applyDefaultBrowserContextBehavior(
  browser: Browser,
  context: BrowserContext,
  options: DefaultBrowserContextBehaviorOptions | false = {},
): Promise<BrowserContext> {
  if (options === false) return context;
  if (options.fingerprint !== false) {
    await applyStableFingerprintNoiseToContext(context, options.fingerprintSeed);
  }
  if (options.normalizeChromeIdentity !== false) {
    await applyChromeIdentityToContext(browser, context, options.identityProbeUrl);
  }
  return context;
}

export async function createDefaultBrowserContext(
  browser: Browser,
  contextOptions: BrowserContextOptions = {},
  behaviorOptions: DefaultBrowserContextBehaviorOptions | false = {},
): Promise<BrowserContext> {
  const context = await browser.newContext(defaultBrowserContextOptions(contextOptions));
  try {
    return await applyDefaultBrowserContextBehavior(browser, context, behaviorOptions);
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}
