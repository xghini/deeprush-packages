import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {CDPSession, Frame, Page} from 'playwright';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  createCloudflareCdpCheckboxClicker,
  isCloudflareChallengeFrameUrl,
} from '../src/cloudflare-cdp.js';

function checkboxDocument() {
  return {
    root: {
      nodeName: '#document',
      shadowRoots: [{
        nodeName: '#document-fragment',
        children: [{
          nodeName: 'INPUT',
          backendNodeId: 73,
          attributes: ['type', 'checkbox'],
        }],
      }],
    },
  };
}

function createChallengeFrame(url = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile') {
  return {url: () => url} as Frame;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Cloudflare CDP checkbox capability', () => {
  it('matches the ITDOG challenge child-frame URL boundary', () => {
    expect(isCloudflareChallengeFrameUrl(
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile',
    )).toBe(true);
    expect(isCloudflareChallengeFrameUrl(
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/orchestrate',
    )).toBe(true);
    expect(isCloudflareChallengeFrameUrl('https://challenges.cloudflare.com/')).toBe(false);
    expect(isCloudflareChallengeFrameUrl('https://example.com/challenge-platform')).toBe(false);
  });

  it('finds the real checkbox and sends ITDOG coordinates and timing on the same child-frame session', async () => {
    vi.useFakeTimers();
    const frame = createChallengeFrame();
    const calls: Array<{method: string; params?: unknown}> = [];
    const targets: Array<Page | Frame> = [];
    let detached = 0;
    const session = {
      send: async (method: string, params?: unknown) => {
        calls.push({method, params});
        if (method === 'DOM.getDocument') return checkboxDocument();
        if (method === 'DOM.getBoxModel') {
          return {model: {content: [100, 200, 120, 200, 120, 220, 100, 220]}};
        }
        return {};
      },
      detach: async () => {
        detached += 1;
      },
    } as unknown as CDPSession;
    const page = {
      frames: () => [frame],
      context: () => ({
        newCDPSession: async (target: Page | Frame) => {
          targets.push(target);
          return session;
        },
      }),
    } as unknown as Page;

    const clicker = await createCloudflareCdpCheckboxClicker(page);
    const pending = clicker.tryClick();
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(targets).toEqual([frame]);
    expect(result).toMatchObject({
      frameId: frame.url(),
      backendNodeId: 73,
      layoutReady: true,
      x: 112,
      y: 210,
    });
    expect(result?.clickedAt).toEqual(expect.any(Number));
    expect(calls.map(call => call.method)).toEqual([
      'DOM.enable',
      'DOM.getDocument',
      'DOM.getBoxModel',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
    expect(calls.slice(-3).map(call => call.params)).toEqual([
      {
        type: 'mouseMoved', x: 112, y: 210, button: 'none', buttons: 0,
        pointerType: 'mouse',
      },
      {
        type: 'mousePressed', x: 112, y: 210, button: 'left', buttons: 1,
        clickCount: 1, pointerType: 'mouse',
      },
      {
        type: 'mouseReleased', x: 112, y: 210, button: 'left', buttons: 0,
        clickCount: 1, pointerType: 'mouse',
      },
    ]);

    await expect(clicker.tryClick()).resolves.toMatchObject({alreadyClicked: true});
    expect(calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(3);
    await clicker.dispose();
    await clicker.dispose();
    expect(detached).toBe(1);
    await expect(clicker.tryClick()).rejects.toThrow('disposed');
  });

  it('waits for checkbox layout, retries the same Frame, and clicks a replacement Frame once', async () => {
    vi.useFakeTimers();
    const firstFrame = createChallengeFrame();
    const replacementFrame = createChallengeFrame(
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/re-signed',
    );
    let activeFrame = firstFrame;
    let firstDocumentReads = 0;
    const inputCounts = new Map<Frame, number>();
    const sessions = new Map<Frame, CDPSession>();
    const page = {
      frames: () => [activeFrame],
      context: () => ({
        newCDPSession: async (target: Frame) => {
          const session = {
            send: async (method: string) => {
              if (method === 'DOM.getDocument') {
                if (target === firstFrame && firstDocumentReads++ === 0) {
                  return {root: {nodeName: '#document'}};
                }
                return checkboxDocument();
              }
              if (method === 'DOM.getBoxModel') {
                return {model: {content: [20, 40, 40, 40, 40, 60, 20, 60]}};
              }
              if (method === 'Input.dispatchMouseEvent') {
                inputCounts.set(target, (inputCounts.get(target) || 0) + 1);
              }
              return {};
            },
            detach: async () => undefined,
          } as unknown as CDPSession;
          sessions.set(target, session);
          return session;
        },
      }),
    } as unknown as Page;

    const clicker = await createCloudflareCdpCheckboxClicker(page);
    await expect(clicker.tryClick()).resolves.toMatchObject({layoutReady: false});
    const firstClick = clicker.tryClick();
    await vi.runAllTimersAsync();
    await expect(firstClick).resolves.toMatchObject({layoutReady: true, x: 32, y: 50});
    expect(sessions.size).toBe(1);

    activeFrame = replacementFrame;
    const replacementClick = clicker.tryClick();
    await vi.runAllTimersAsync();
    await expect(replacementClick).resolves.toMatchObject({
      frameId: replacementFrame.url(),
      layoutReady: true,
    });
    expect(inputCounts.get(firstFrame)).toBe(3);
    expect(inputCounts.get(replacementFrame)).toBe(3);
    expect(sessions.size).toBe(2);
    await clicker.dispose();
  });

  it('contains no fallback to the superseded page-session AX and fixed-offset route', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/cloudflare-cdp.ts', import.meta.url)), 'utf8');
    for (const removed of [
      'Accessibility.',
      'DOM.getFlattenedDocument',
      'Page.getFrameTree',
      'page.screenshot',
      'originX + 21',
      'previousReadySignature',
      'newCDPSession(page)',
    ]) {
      expect(source).not.toContain(removed);
    }
  });
});
