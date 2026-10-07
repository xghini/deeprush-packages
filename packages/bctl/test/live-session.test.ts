import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {chromium, type Browser, type Page} from 'playwright';
import {findOwnedPage} from '../src/page-ownership.js';
import {readRecaptchaState} from '../src/recaptcha.js';
import {watchPage, type PageWatchEvent} from '../src/page-watch.js';

// Real Chrome (headless) where behaviour depends on the browser; each such case skips itself without one.
let browser: Browser | null = null;
let server: http.Server;
let port = 0;
let debugPort = 0;
const html = (body: string) => `<!doctype html><html><body style="margin:0">${body}</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, {'content-type': 'text/html'});
    const url = req.url || '/';
    // Stand-ins for reCAPTCHA's frames: the paths carry the words the helpers look for.
    if (url.startsWith('/recaptcha/anchor-drawn')) return res.end(html('<span id="recaptcha-anchor" role="checkbox" style="display:inline-block;width:28px;height:28px"></span>'));
    if (url.startsWith('/recaptcha/anchor-empty')) return res.end(html(''));
    if (url.startsWith('/recaptcha/bframe')) return res.end(html('challenge'));
    if (url.startsWith('/page/checkbox')) return res.end(html('<iframe name="a-drawn" src="/recaptcha/anchor-drawn" style="width:302px;height:76px;border:0"></iframe><iframe name="a-invisible" src="/recaptcha/anchor-empty" style="width:0;height:0;border:0"></iframe>'));
    if (url.startsWith('/page/stuck')) return res.end(html('<iframe name="a-stuck" src="/recaptcha/anchor-empty" style="width:302px;height:76px;border:0"></iframe>'));
    if (url.startsWith('/page/challenge')) return res.end(html('<iframe name="c-open" src="/recaptcha/bframe" style="width:400px;height:580px;border:0"></iframe><iframe name="c-expired" src="/recaptcha/bframe" style="width:400px;height:580px;border:0;visibility:hidden"></iframe>'));
    if (url.startsWith('/page/expired')) return res.end(html('<iframe name="c-expired" src="/recaptcha/bframe" style="width:400px;height:580px;border:0;visibility:hidden"></iframe><iframe name="a-invisible" src="/recaptcha/anchor-empty" style="width:0;height:0;border:0"></iframe>'));
    if (url.startsWith('/fetch-target')) return res.end('ok');
    return res.end(html('plain'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  // A free port for Chrome's DevTools HTTP endpoint, where watchPage gets a page's WebSocket URL.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  debugPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  browser = await chromium.launch({channel: 'chrome', headless: true, args: [`--remote-debugging-port=${debugPort}`]}).catch(() => null);
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const base = () => `http://127.0.0.1:${port}`;

describe('findOwnedPage', () => {
  type Fake = {name?: string; url: () => string; isClosed: () => boolean; context: () => unknown; close: () => Promise<void>; once: () => void; closed?: boolean};
  const ctxA = {pages: () => [] as Fake[]};
  const fake = (name: string | undefined, url: string, context: unknown = ctxA): Fake => {
    const page: Fake = {name, url: () => url, isClosed: () => Boolean(page.closed), context: () => context, close: async () => { page.closed = true; }, once: () => {}};
    return page;
  };
  const options = {isTarget: (url: string) => url.startsWith('https://site.test/app'), isSameSite: (url: string) => url.startsWith('https://site.test/')};

  it('finds the one named target page', () => {
    const page = fake('n1', 'https://site.test/app/1');
    expect(findOwnedPage([page, fake('n2', 'https://site.test/app/2')] as never, [], 'n1', options)).toBe(page);
  });

  it('still finds the named page taken elsewhere on the same site, not on another site', () => {
    const away = fake('n1', 'https://site.test/leaderboard');
    expect(findOwnedPage([away] as never, [], 'n1', options)).toBe(away);
    expect(findOwnedPage([fake('n1', 'https://other.test/')] as never, [], 'n1', options)).toBeNull();
  });

  it('resolves settled duplicates in one Context (keeps the newest, closes the rest), not fresh ones', () => {
    const old = fake('n1', 'https://site.test/app/x');
    const newer = fake('n1', 'https://site.test/app/x');
    expect(findOwnedPage([old, newer] as never, [], 'n1', {...options, settleMs: 50})).toBeNull();
    const seen = Symbol.for('bctl.find-owned-page.seen-at');
    (old as unknown as Record<symbol, number>)[seen] = Date.now() - 1000;
    (newer as unknown as Record<symbol, number>)[seen] = Date.now() - 1000;
    expect(findOwnedPage([old, newer] as never, [], 'n1', {...options, settleMs: 50})).toBe(newer);
    expect(old.closed).toBe(true);
  });

  it('re-attaches the single target page of the owned Context', () => {
    const owner = Symbol.for('apanel.browser-session.context-owner.v1');
    const page = fake(undefined, 'https://site.test/app/z');
    const context = {pages: () => [page], [owner]: {pageName: 'n9'}};
    const pages: Fake[] = [];
    expect(findOwnedPage(pages as never, [context] as never, 'n9', options)).toBe(page);
    expect(page.name).toBe('n9');
    expect(pages).toContain(page);
  });
});

describe('readRecaptchaState (read-only)', () => {
  const open = async (path: string): Promise<Page> => {
    const page = await browser!.newPage();
    await page.goto(`${base()}${path}`, {waitUntil: 'load'});
    return page;
  };

  it('a drawn checkbox is actionable; the invisible anchor is not counted', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open('/page/checkbox');
    expect(await readRecaptchaState(page)).toEqual({anchorShown: true, checkboxDrawn: true, challengeOpen: false, actionable: true});
    await page.close();
  }, 30_000);

  it('a shown anchor with no checkbox drawn is not actionable (stuck)', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open('/page/stuck');
    expect(await readRecaptchaState(page)).toEqual({anchorShown: true, checkboxDrawn: false, challengeOpen: false, actionable: false});
    await page.close();
  }, 30_000);

  it('an open challenge is actionable; hidden (expired) challenges and the invisible anchor are not', async (ctx) => {
    if (!browser) return ctx.skip();
    const openPage = await open('/page/challenge');
    expect((await readRecaptchaState(openPage)).challengeOpen).toBe(true);
    await openPage.close();
    const expired = await open('/page/expired');
    expect(await readRecaptchaState(expired)).toEqual({anchorShown: false, checkboxDrawn: false, challengeOpen: false, actionable: false});
    await expired.close();
  }, 30_000);
});

describe('watchPage', () => {
  it('reports load and the tracked requests of a page it only listens to', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    await page.goto(`${base()}/plain`);
    const session = await page.context().newCDPSession(page);
    const {targetInfo} = await session.send('Target.getTargetInfo');
    await session.detach();
    const events: PageWatchEvent[] = [];
    const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json() as Promise<Array<{id: string; webSocketDebuggerUrl: string}>>).catch(() => null);
    if (!list) return ctx.skip();
    const target = list.find((item) => item.id === targetInfo.targetId);
    if (!target) return ctx.skip();
    const watch = watchPage({
      resolveWsUrl: async () => target.webSocketDebuggerUrl,
      onEvent: (event) => events.push(event),
      trackRequest: (url) => url.includes('/fetch-target'),
      retryMs: 1000,
    });
    await waitFor(() => events.some((event) => event.type === 'open'));
    await page.evaluate((url) => fetch(url).then((r) => r.text()), `${base()}/fetch-target`);
    await page.reload();
    await waitFor(() => events.some((event) => event.type === 'response') && events.some((event) => event.type === 'load'));
    watch.close();
    const response = events.find((event) => event.type === 'response') as Extract<PageWatchEvent, {type: 'response'}>;
    expect(response.url).toContain('/fetch-target');
    expect(response.status).toBe(200);
    expect(events.filter((event) => event.type === 'request').every((event) => (event as {url: string}).url.includes('/fetch-target'))).toBe(true);
    await page.close();
  }, 30_000);
});

async function waitFor(check: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
