import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {BrowserContext, CDPSession, Locator, Page} from 'playwright';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  BCTL_UNEXPECTED_PAGE,
  bctlClick,
  bctlInput,
  bctlTypeKeystrokes,
  normalizeBctlInputTiming,
} from '../src/interaction.js';

type HarnessOptions = {
  current?: string;
  focus?: boolean[];
  openPageOnClick?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
  let value = options.current ?? '';
  const focus = [...(options.focus ?? [true])];
  const calls: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const cdp: Array<{method: string; params: Record<string, unknown>}> = [];
  const listeners = new Set<(page: Page) => void>();
  let closedPages = 0;
  const createdPage = {close: async () => { closedPages += 1; }} as unknown as Page;
  const session = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      cdp.push({method, params});
      return {};
    },
    detach: async () => { calls.push('detach'); },
  } as unknown as CDPSession;
  const context = {
    newCDPSession: async () => session,
    on: (event: string, listener: (page: Page) => void) => {
      if (event === 'page') listeners.add(listener);
    },
    off: (event: string, listener: (page: Page) => void) => {
      if (event === 'page') listeners.delete(listener);
    },
  } as unknown as BrowserContext;
  const page = {context: () => context} as unknown as Page;
  const locator = {
    page: () => page,
    waitFor: async (input: {timeout?: number}) => { calls.push('waitFor'); timeouts.push(input.timeout); },
    scrollIntoViewIfNeeded: async (input: {timeout?: number}) => { calls.push('scroll'); timeouts.push(input.timeout); },
    boundingBox: async (input: {timeout?: number}) => {
      timeouts.push(input.timeout);
      return {x: 10, y: 20, width: 120, height: 32};
    },
    click: async (input: {timeout?: number}) => {
      calls.push('click');
      timeouts.push(input.timeout);
      if (options.openPageOnClick) for (const listener of listeners) listener(createdPage);
    },
    fill: async (next: string) => {
      calls.push(`fill:${next}`);
      value = next;
    },
    inputValue: async () => value,
    evaluate: async (fn: Function) => {
      if (String(fn).includes('document.activeElement')) return focus.shift() ?? false;
      return true;
    },
  } as unknown as Locator;
  return {
    calls,
    cdp,
    locator,
    timeouts,
    get closedPages() { return closedPages; },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BCTL robust interaction', () => {
  it('defaults click and input to turbo', async () => {
    const click = createHarness();
    await expect(bctlClick(click.locator)).resolves.toMatchObject({transport: 'turbo'});
    expect(click.calls).toEqual(['waitFor', 'scroll', 'click']);
    expect(click.timeouts).toEqual(Array(4).fill(12 * 60 * 60 * 1_000));

    const input = createHarness();
    await bctlInput(input.locator, '123 45', {comparison: 'digits'});
    expect(input.calls).toEqual(['scroll', 'fill:123 45']);
  });

  it('does not clear an empty human input before typing', async () => {
    const harness = createHarness({current: '', focus: [true]});
    await bctlInput(harness.locator, 'Ab', {
      beforeTypeDelay: 0,
      inputMode: 'human',
      keyDelay: 0,
      keyPressDelay: 0,
      readback: 'none',
      scrollMode: 'turbo',
    });
    const keys = harness.cdp.filter(call => call.method === 'Input.dispatchKeyEvent');
    expect(keys.some(call => call.params.key === 'Backspace')).toBe(false);
    expect(keys.some(call => call.params.key === 'a' && call.params.commands)).toBe(false);
  });

  it.each([
    ['Control' as const, 'Control'],
    ['Meta' as const, 'Meta'],
  ])('clears an existing value with the selected %s modifier', async (selectAllModifier, expected) => {
    const harness = createHarness({current: 'old', focus: [true]});
    await bctlInput(harness.locator, 'new', {
      beforeTypeDelay: 0,
      inputMode: 'human',
      keyDelay: 0,
      keyPressDelay: 0,
      readback: 'none',
      scrollMode: 'turbo',
      selectAllModifier,
    });
    expect(harness.cdp.some(call =>
      call.method === 'Input.dispatchKeyEvent' && call.params.key === expected
    )).toBe(true);
    expect(harness.cdp.some(call =>
      call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Backspace'
    )).toBe(true);
  });

  it('refuses to type when a second click still does not focus the input', async () => {
    vi.useFakeTimers();
    const harness = createHarness({focus: [false, false]});
    const pending = bctlInput(harness.locator, 'unsafe', {
      beforeTypeDelay: 0,
      inputMode: 'human',
      readback: 'none',
      scrollMode: 'turbo',
    });
    const assertion = expect(pending).rejects.toThrow('点击两次后仍未获得焦点');
    await vi.runAllTimersAsync();
    await assertion;
    expect(harness.cdp).toHaveLength(0);
  });

  it('honors an already-aborted signal before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness();
    await expect(bctlClick(harness.locator, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(harness.calls).toEqual([]);
  });

  it('bounds CDP session creation by default-facing timeout options', async () => {
    const page = {
      context: () => ({newCDPSession: () => new Promise(() => {})}),
    } as unknown as Page;
    await expect(bctlTypeKeystrokes(page, 'x', {timeout: 5})).rejects.toMatchObject({name: 'TimeoutError'});
  });

  it('keeps the long-lived BCTL default out of short-timeout ranges', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/interaction.ts', import.meta.url)), 'utf8');
    expect(source).toContain('12 * 60 * 60 * 1_000');
    expect(source).not.toContain('const BCTL_ACTION_TIMEOUT = 30_000');
  });

  it('closes and reports a newly opened page when requested', async () => {
    const harness = createHarness({openPageOnClick: true});
    await expect(bctlClick(harness.locator, {rejectNewPages: true})).rejects.toThrow(BCTL_UNEXPECTED_PAGE);
    expect(harness.closedPages).toBe(1);
  });

  it('normalizes timing ranges without exposing workflow-specific state', () => {
    expect(normalizeBctlInputTiming({
      characterDelay: [180, 60],
      keyPressDelay: [-1, 2_000],
      beforeInputDelay: ['bad', 1],
    })).toEqual({
      characterDelay: [60, 180],
      keyPressDelay: [0, 1_000],
      beforeInputDelay: [200, 800],
    });
  });

  it('keeps final human target correction on a continuous trajectory', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/interaction.ts', import.meta.url)), 'utf8');
    const finalCorrection = source.slice(source.indexOf('let finalTargetReady'), source.indexOf("if (!finalTargetReady)"));
    expect(finalCorrection).toContain('movePointer(session, page, target.absolute, guard)');
    expect(finalCorrection).not.toContain('dispatchMouseMove(session, page, target.absolute, guard)');
    expect(source).toContain('canReusePointerForCdpScroll');
  });
});
