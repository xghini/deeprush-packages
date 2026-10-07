# @deeprush/bctl

Framework-independent browser control utilities for Node.js and Playwright.

## Features

- Remote function execution client with explicit `remoteData` transport
- Playwright CDP connection and context helpers
- Default contexts with native viewport, fixed English locale/header, kernel-matched UA/UA-CH and stable per-context rendering variation
- IP-adaptive contexts with proxy-matched timezone and geolocation
- Cross-context public static-resource cache with LRU, TTL and in-flight coalescing
- Human-like click and typing helpers with stable business-specific policies
- Cloudflare checkbox input through the shared ITDOG-proven child-Frame CDP capability
- TOTP generation and navigation retry helpers
- BitBrowser profile management without a `ghini` runtime dependency

## Install

```bash
pnpm add @deeprush/bctl playwright
```

## Remote execution

```ts
import {createRemoteCtl} from '@deeprush/bctl';

const remoteCtl = createRemoteCtl({
  serverUrl: 'http://127.0.0.1:3175/remoteCtl',
});

const remoteData = {fallbackUrl: 'about:blank'};
const result = await remoteCtl(async pages => {
  const page = pages[0];
  return page ? {url: page.url(), title: await page.title()} : {url: remoteData.fallbackUrl, title: ''};
}, remoteData);
```

Remote functions are serialized. They cannot capture local closure variables; pass dynamic values through the variable named `remoteData`.

## JSRPC v2

JSRPC v2 is the versioned in-memory action protocol for the long-lived Browser
kernel. The controller registers a hashed, self-contained IIFE release and then
invokes actions with explicit `runtime` and `input` arguments. The Browser does
not need a business source file on disk and keeps release/operation state only in
memory; the controller remains the owner of workflow, persistence and retries.

```ts
import {createJsrpcClient} from '@deeprush/bctl/jsrpc';
import {buildJsrpcBundle} from '@deeprush/bctl/jsrpc-build';

const release = await buildJsrpcBundle({
  manifest: {
    kernelAbiRange: '1.x',
    actions: [{name: 'readTitle', mutation: 'read'}],
  },
  source: `(runtime, input) => ({title: runtime.pages[input.index]?.url()})`,
});

const jsrpc = createJsrpcClient({serverUrl: 'http://127.0.0.1:3175'});
await jsrpc.registerRelease(release);
const result = await jsrpc.invoke({
  operationId: crypto.randomUUID(),
  releaseId: release.releaseId,
  action: 'readTitle',
  input: {index: 0},
  waitMs: 30_000,
});

// Controller-side canonical entry build: local imports are recursively bundled.
const releaseFromEntry = await buildJsrpcBundle({
  entryPath: 'C:/path/to/apanel-action.ts',
  manifest: {kernelAbiRange: '1.x', actions: [{name: 'iam', mutation: 'external-write'}]},
});
const terminal = await jsrpc.invokeAndWait({
  operationId: crypto.randomUUID(),
  releaseId: releaseFromEntry.releaseId,
  action: 'iam',
  input: {email: 'example@example.com'},
}, {signal: AbortSignal.timeout(120_000)});
```

`@deeprush/bctl` remains the single protocol owner. The existing
`createRemoteCtl` v1 client and `/remoteCtl` endpoint remain unchanged while
routes migrate to JSRPC v2. Entry bundles may use local TS/JS imports, but the
builder rejects dynamic imports, residual externals, Playwright, filesystem,
database, AWS SDK and other host/business dependencies. Browser actions use the
explicit `runtime` capability ABI. `runtime.checkpoint(payload, type)` sends a
strictly increasing sequence and event fingerprint to the controller and waits
for a matching `{accepted: true, operationId, sequence}` ack. Missing callbacks,
undefined/fake/rejected/mismatched acknowledgements fail closed; failed events
retain their sequence and are retried with the same fingerprint.

The following legacy behavior is v1-only: free identifiers provided by the
`/remoteCtl` evaluator belong to the long-lived browser host, and v1 callers may
select version-changing business actions through a dynamically loaded remote
callback. JSRPC v2 bundles must not use that host scope or dynamic imports; they
are selected by releaseId and receive only explicit `runtime`/`input`. See the
[project map](MAP.md) and the [browser lifecycle debt record](references/2026-07-23-jsrpc-static-action-browser-lifecycle-debt.md).

## BitBrowser

```ts
import {createBitBrowserClient} from '@deeprush/bctl';

const bctl = createBitBrowserClient();
const profiles = await bctl.list();

const custom = createBitBrowserClient({
  baseUrl: 'http://127.0.0.1:54345',
});
```

## Robust interaction

`bctlClick` and `bctlInput` are the canonical interaction base. Both default to
Playwright's fast `turbo` transport; pass `scrollMode: 'human'` and, for input,
`inputMode: 'human'` to use CDP wheel, pointer trajectories, and per-key input.
The interaction module owns pointer and timing state and accepts an optional
`AbortSignal`, caller guard, obstruction recovery callback, and explicit
`waitMode: 'guarded'` for workflows whose business owner controls cancellation.
DOM and interaction operations default to a 12-hour timeout; short probes must
pass their own explicit timeout.

```ts
import {bctlClick, bctlInput} from '@deeprush/bctl/interaction';

await bctlInput(page.locator('#email'), 'user@example.com');
await bctlClick(page.getByRole('button', {name: 'Next'}));
```

The older `humanClick` and `humanType` helpers remain compatible for lightweight
flows; robust workflows should use the interaction module. `humanClick` takes
`totalTimeout` to give the whole click (wait, focus, measure, click) one budget.

## Live sessions: never disturb the windows

Long-running headful sessions (account windows, chat nodes, game sessions) are
read and watched in the background. Nothing may create, navigate, activate,
focus or close their pages unless a person asked for exactly that.

- **Snapshots**: never call Playwright's native `context.storageState()`. For every
  origin the Context ever visited without an open page it opens a temporary page,
  which raises that window (2026-10-07: every node window in turn, half a second
  apart), and it reads unpartitioned storage the pages' iframes never use. Use
  `captureContextStorageState(context, previous)` from `@deeprush/bctl/context-snapshot`:
  existing frames only, the previous snapshot carried for origins not open now,
  failed reads kept and listed. A Browser host that must keep older callers safe
  installs `installContextSnapshotHost(contexts)`; a running host that loaded an
  older package receives `(${CONTEXT_SNAPSHOT_KIT_SOURCE})()`.
- **Which page is a record's**: `findOwnedPage` (named page, settled duplicates,
  same-site detours, re-attach from the owned Context).
- **Watching**: `watchPage` listens on a CDP connection of its own (Page and Network
  only, out-of-process frames auto-attached) instead of polling the page.
- **Human checks**: `readRecaptchaState` only reads whether a person can act (a
  drawn checkbox or an open challenge). Nothing here clicks or solves.
- `bringToFront` is for an explicit user action only, never for a background step.

`findOwnedPage` and `readRecaptchaState` are self-contained, so a controller can
install them into a running Browser host with their source.

## Development

```bash
npm install
npm run check
npm run version:calendar
```

Versions follow DeepRush calendar SemVer: `YY.MDD.<h*10000+m*100+s>`.
`version:calendar` writes only this package's version and bumps by one calendar
second when the injected/current clock would otherwise repeat or go backwards.

## IP-adaptive context

```ts
import {
  DEFAULT_CHROMIUM_IGNORE_ARGS,
  DEFAULT_CHROMIUM_LAUNCH_ARGS,
  createIpAdaptiveContext,
} from '@deeprush/bctl';

const browser = await chromium.launch({
  args: [...DEFAULT_CHROMIUM_LAUNCH_ARGS],
  ignoreDefaultArgs: [...DEFAULT_CHROMIUM_IGNORE_ARGS],
});
const {context, environment} = await createIpAdaptiveContext(browser, {
  proxy: {server: 'http://127.0.0.1:50009'},
  fallbackTimezone: 'Asia/Tokyo',
  contextOptions: {viewport: null, acceptDownloads: true},
});
```

`DEFAULT_CHROMIUM_IGNORE_ARGS` removes Playwright's automation marker and its
`--disable-ipc-flooding-protection` default, so Chromium's native IPC flood rate limit remains enabled.
`DEFAULT_CHROMIUM_LAUNCH_ARGS` keeps Browser-owned language surfaces aligned with
`--lang=en-US --accept-lang=en-US,en`. macOS Chromium initializes ICU from the
Chrome application bundle's Cocoa localization; deployments that require an exact
ICU locale must align that app-specific preference instead of passing bare Cocoa
argument values through Playwright launch args.

Every context created through this API defaults to native viewport mode and inherits
the Browser language without injecting a second Context-level `locale` or `Accept-Language`
owner. Explicitly supplied Context locale and headers are preserved. Contexts also use exact UA/UA-CH
from the selected Chrome kernel, a native macOS font baseline with one of five stable
optional-font availability profiles, and a stable per-context seed for
Font/Canvas/Audio/WebGL variation. The optional-font profiles only use server-accepted
macOS font sets; wrapped browser methods retain their native callable shape. Timezone and
geolocation follow the detected proxy exit. Detection results and concurrent probes are
shared by proxy.

## Shared context cache

```ts
import {createSharedContextCache} from '@deeprush/bctl';

const staticCache = createSharedContextCache({
  shouldCache: ({url, resourceType}) =>
    ['script', 'stylesheet'].includes(resourceType) && new URL(url).hostname.endsWith('.example.com'),
});

await staticCache.attach(contextA);
await staticCache.attach(contextB);
```

Only public, reusable responses are cached by default. Responses with `Set-Cookie` or `Vary: Cookie/Authorization` are never shared.

## Cloudflare CDP checkbox

```ts
import {createCloudflareCdpCheckboxClicker} from '@deeprush/bctl/cloudflare-cdp';

const clicker = await createCloudflareCdpCheckboxClicker(page);
try {
  const click = await clicker.tryClick();
  if (click?.clickedAt) console.log(click.frameId, click.x, click.y);
} finally {
  await clicker.dispose();
}
```

The capability is the ITDOG production route, not a parallel approximation. It attaches CDP
directly to the Cloudflare child Frame, walks that Frame's DOM to the real
`INPUT[type=checkbox]`, reads that node's box, and sends move/press/release on the same child
session. One clicker represents one challenge cycle: a Frame object is clicked at most once,
while a replacement Frame can be clicked after Cloudflare re-signs the challenge. There is no
page-session, accessibility-tree, outer-iframe fixed-offset, screenshot-stability, or fallback
route. Navigation, polling, site-specific normal-page classification, timeouts, and post-click
pass/fail decisions remain with the caller.
