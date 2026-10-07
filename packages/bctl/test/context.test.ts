import {describe, expect, it} from 'vitest';
import {
  DEFAULT_CHROMIUM_IGNORE_ARGS,
  DEFAULT_CHROMIUM_LAUNCH_ARGS,
  NATURAL_BROWSER_ACCEPT_LANGUAGE,
  NATURAL_BROWSER_ACCEPT_LANGUAGE_HEADER,
  NATURAL_BROWSER_LANGUAGE_PREFERENCES,
  browserContextOptionsForEnvironment,
  defaultBrowserContextOptions,
} from '../src/context.js';

describe('default browser context options', () => {
  it('leaves language to the Browser by default', () => {
    const options = defaultBrowserContextOptions();
    expect(options).toMatchObject({
      acceptDownloads: true,
      viewport: null,
    });
    expect(options).not.toHaveProperty('locale');
    expect(options).not.toHaveProperty('extraHTTPHeaders');
    expect(NATURAL_BROWSER_ACCEPT_LANGUAGE).toBe('en-US,en;q=0.9');
    expect(NATURAL_BROWSER_ACCEPT_LANGUAGE_HEADER).toBe(NATURAL_BROWSER_ACCEPT_LANGUAGE);
    expect(NATURAL_BROWSER_LANGUAGE_PREFERENCES).toBe('en-US,en');
    expect(DEFAULT_CHROMIUM_LAUNCH_ARGS).toContain('--accept-lang=en-US,en');
    expect(DEFAULT_CHROMIUM_IGNORE_ARGS).toContain('--enable-automation');
    expect(DEFAULT_CHROMIUM_IGNORE_ARGS).toContain('--disable-ipc-flooding-protection');
  });

  it('keeps an explicitly requested Context locale without inventing network headers', () => {
    const options = defaultBrowserContextOptions({}, 'en-GB');
    expect(options.locale).toBe('en-GB');
    expect(options).not.toHaveProperty('extraHTTPHeaders');
  });

  it('preserves explicitly supplied headers without rewriting site-owned values', () => {
    expect(defaultBrowserContextOptions({
      extraHTTPHeaders: {
        'accept-language': 'en-GB,en;q=0.8',
        'X-Test': 'yes',
      },
    }).extraHTTPHeaders).toEqual({
      'accept-language': 'en-GB,en;q=0.8',
      'X-Test': 'yes',
    });
  });

  it('keeps proxy-matched timezone and geolocation on top of defaults', () => {
    const options = browserContextOptionsForEnvironment(
      {server: 'http://127.0.0.1:50001'},
      {
        ip: '203.0.113.10',
        countryCode: 'JP',
        timezoneId: 'Asia/Tokyo',
        latitude: 35.6762,
        longitude: 139.6503,
        source: 'ipwho.is',
        detectedAt: '2026-07-24T00:00:00.000Z',
      },
    );
    expect(options).toMatchObject({
      viewport: null,
      timezoneId: 'Asia/Tokyo',
      geolocation: {
        latitude: 35.6762,
        longitude: 139.6503,
        accuracy: 50_000,
      },
      proxy: {server: 'http://127.0.0.1:50001'},
    });
    expect(options).not.toHaveProperty('locale');
    expect(options).not.toHaveProperty('extraHTTPHeaders');
  });
});
