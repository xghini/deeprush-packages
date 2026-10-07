import type {CDPSession, Frame, Page} from 'playwright';

export interface CloudflareCdpClickResult {
  frameSeenAt: number;
  frameId: string;
  alreadyClicked?: true;
  backendNodeId?: number;
  layoutReady?: boolean;
  layoutError?: string;
  clickedAt?: number;
  x?: number;
  y?: number;
}

export interface CloudflareCdpCheckboxClicker {
  tryClick(): Promise<CloudflareCdpClickResult | null>;
  dispose(): Promise<void>;
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

export function isCloudflareChallengeFrameUrl(value: string) {
  return /challenges\.cloudflare\.com\/.*(?:turnstile|challenge-platform)/i.test(
    String(value || ''),
  );
}

function findCheckboxNode(root: any) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    const attributes = node.attributes || [];
    if (
      node.nodeName === 'INPUT' &&
      attributes.some(
        (value: unknown, index: number) =>
          index % 2 === 0 &&
          value === 'type' &&
          attributes[index + 1] === 'checkbox',
      )
    ) {
      return node;
    }
    for (const child of node.children || []) stack.push(child);
    for (const shadowRoot of node.shadowRoots || []) stack.push(shadowRoot);
    for (const pseudoElement of node.pseudoElements || []) stack.push(pseudoElement);
    if (node.contentDocument) stack.push(node.contentDocument);
    if (node.templateContent) stack.push(node.templateContent);
  }
  return undefined;
}

/**
 * ITDOG 现役 Cloudflare 子 Frame 输入路线。
 *
 * 每个实例代表一个挑战循环：同一个 Frame 对象最多成功点击一次；若 Cloudflare
 * 重签并替换 Frame，新 Frame 仍可在同一循环内点击。调用方负责页面终态判断。
 */
export async function createCloudflareCdpCheckboxClicker(
  page: Page,
): Promise<CloudflareCdpCheckboxClicker> {
  const context = page.context();
  const clickedFrames = new Set<Frame>();
  const frameSessions = new Map<Frame, CDPSession>();
  let disposed = false;

  return {
    async tryClick() {
      if (disposed) throw new Error('Cloudflare CDP checkbox clicker has been disposed');
      const frame = page.frames().find(candidate =>
        isCloudflareChallengeFrameUrl(candidate.url()),
      );
      if (!frame) return null;

      const frameSeenAt = Date.now();
      const frameId = frame.url();
      if (clickedFrames.has(frame)) {
        return {frameSeenAt, frameId, alreadyClicked: true};
      }

      let session = frameSessions.get(frame);
      if (!session) {
        session = await context.newCDPSession(frame);
        frameSessions.set(frame, session);
        await session.send('DOM.enable');
      }

      const document = await session.send('DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      const checkbox = findCheckboxNode(document.root);
      if (!checkbox) {
        return {
          frameSeenAt,
          frameId,
          layoutReady: false,
        };
      }

      let box: Awaited<ReturnType<CDPSession['send']>>;
      try {
        box = await session.send('DOM.getBoxModel', {
          backendNodeId: checkbox.backendNodeId,
        });
      } catch (error) {
        return {
          frameSeenAt,
          frameId,
          backendNodeId: checkbox.backendNodeId,
          layoutReady: false,
          layoutError: String(error || ''),
        };
      }

      const content = (box as {model?: {content?: number[]}})?.model?.content || [];
      if (content.length < 8) {
        return {
          frameSeenAt,
          frameId,
          backendNodeId: checkbox.backendNodeId,
          layoutReady: false,
        };
      }

      const xs = content.filter((_, index) => index % 2 === 0);
      const ys = content.filter((_, index) => index % 2 === 1);
      const x = Math.min(...xs) + 12;
      const y = (Math.min(...ys) + Math.max(...ys)) / 2;
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        buttons: 0,
        pointerType: 'mouse',
      });
      await sleep(120);
      const clickedAt = Date.now();
      await session.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        pointerType: 'mouse',
      });
      await sleep(90);
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        pointerType: 'mouse',
      });
      clickedFrames.add(frame);
      return {
        frameSeenAt,
        clickedAt,
        frameId,
        backendNodeId: checkbox.backendNodeId,
        layoutReady: true,
        x,
        y,
      };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all(
        [...frameSessions.values()].map(session =>
          session.detach().catch(() => undefined),
        ),
      );
      frameSessions.clear();
    },
  };
}
