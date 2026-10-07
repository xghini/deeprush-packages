import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {chromium, type Browser} from 'playwright';
import {CONTEXT_SNAPSHOT_KIT_SOURCE, captureContextStorageState, type ContextSnapshotKit} from '../src/context-snapshot.js';

// Real Chrome (headless): the point is what happens to pages, which a mock cannot show.
let browser: Browser | null = null;
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'text/html'});
    res.end('<html><body>ok</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  browser = await chromium.launch({channel: 'chrome', headless: true}).catch(() => null);
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Two origins on one server: 127.0.0.1 and localhost differ by host.
const originA = () => `http://127.0.0.1:${port}`;
const originB = () => `http://localhost:${port}`;

// Every page target Chrome creates, Playwright's internal ones included (those raise no 'page' event).
async function watchTargets() {
  const session = await browser!.newBrowserCDPSession();
  const created: string[] = [];
  session.on('Target.targetCreated', ({targetInfo}: {targetInfo: {type: string; url: string}}) => {
    if (targetInfo.type === 'page') created.push(targetInfo.url);
  });
  await session.send('Target.setDiscoverTargets', {discover: true});
  // setDiscoverTargets replays the existing targets first: count only what comes after.
  await new Promise((resolve) => setTimeout(resolve, 200));
  created.length = 0;
  return {created, stop: () => session.detach()};
}

async function contextWithHistory() {
  const context = await browser!.newContext();
  const visited = await context.newPage();
  await visited.goto(`${originB()}/`);
  await visited.evaluate(() => localStorage.setItem('b', 'from-closed-page'));
  await visited.close();
  const page = await context.newPage();
  await page.goto(`${originA()}/`);
  await page.evaluate(() => localStorage.setItem('a', 'open'));
  return {context, page};
}

// Without a local Chrome each case skips itself.
describe('non-disruptive context snapshot', () => {
  it('reads open pages only, opens no page, carries what the previous snapshot had', async (ctx) => {
    if (!browser) return ctx.skip();
    const {context} = await contextWithHistory();
    const watch = await watchTargets();
    const opened = watch.created;
    const previous = {cookies: [], origins: [{origin: originB(), localStorage: [{name: 'b', value: 'kept'}]}]};
    const state = await captureContextStorageState(context, previous);
    expect(opened).toEqual([]);
    expect(context.pages()).toHaveLength(1);
    expect(state.capture.freshOrigins).toEqual([originA()]);
    expect(state.capture.carriedOrigins).toEqual([originB()]);
    expect(state.origins.find((o) => o.origin === originA())?.localStorage).toEqual([{name: 'a', value: 'open'}]);
    expect(state.origins.find((o) => o.origin === originB())?.localStorage).toEqual([{name: 'b', value: 'kept'}]);
    await watch.stop();
    await context.close();
  }, 30_000);

  it('works from its injected source, as a running Browser host receives it', async (ctx) => {
    if (!browser) return ctx.skip();
    const kit = new Function(`const __name = (value) => value; return (${CONTEXT_SNAPSHOT_KIT_SOURCE})();`)() as ContextSnapshotKit;
    const {context} = await contextWithHistory();
    const watch = await watchTargets();
    const opened = watch.created;
    const state = await kit.captureContextStorageState(context);
    expect(opened).toEqual([]);
    expect(state.capture.freshOrigins).toEqual([originA()]);
    await watch.stop();
    await context.close();
  }, 30_000);

  it('native storageState opens a page for a visited origin with none open (why this exists)', async (ctx) => {
    if (!browser) return ctx.skip();
    const {context} = await contextWithHistory();
    const watch = await watchTargets();
    const opened = watch.created;
    await context.storageState();
    expect(opened.length).toBeGreaterThan(0);
    await watch.stop();
    await context.close();
  }, 30_000);

  it('a host install turns native storageState non-disruptive for every Context of that prototype', async (ctx) => {
    if (!browser) return ctx.skip();
    const kit = new Function(`return (${CONTEXT_SNAPSHOT_KIT_SOURCE})();`)() as ContextSnapshotKit;
    const {context} = await contextWithHistory();
    const proto = Object.getPrototypeOf(context);
    const native = proto.storageState;
    try {
      kit.installContextSnapshotHost([context]);
      const later = await contextWithHistory();
      const watch = await watchTargets();
      const opened = watch.created;
      const state = await later.context.storageState() as {capture?: {mode: string}};
      expect(opened).toEqual([]);
      expect(state.capture?.mode).toBe('existing-frames-only');
      await watch.stop();
      await later.context.close();
    } finally {
      proto.storageState = native;
      delete (context as unknown as {storageState?: unknown}).storageState;
      await context.close();
    }
  }, 30_000);
});
