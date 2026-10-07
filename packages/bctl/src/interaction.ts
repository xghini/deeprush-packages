import type {BrowserContext, CDPSession, Locator, Page} from 'playwright';

export type BctlInteractionMode = 'human' | 'turbo';
export type BctlWaitMode = 'bounded' | 'guarded';
export type BctlInputTiming = {
  characterDelay: [number, number];
  keyPressDelay: [number, number];
  beforeInputDelay: [number, number];
};

export const DEFAULT_BCTL_INPUT_TIMING: BctlInputTiming = {
  characterDelay: [60, 180],
  keyPressDelay: [30, 60],
  beforeInputDelay: [200, 800],
};

type BctlInteractionControl = {
  guard?: () => void;
  signal?: AbortSignal;
  waitMode?: BctlWaitMode;
};

type BctlLocatorClickOptions = {
  force?: boolean;
  noWaitAfter?: boolean;
  timeout?: number;
  trial?: boolean;
};

export type BctlInputOptions = BctlInteractionControl & {
  beforeTypeDelay?: number | readonly [number, number];
  comparison?: 'exact' | 'digits';
  keyDelay?: number | readonly [number, number];
  keyPressDelay?: number | readonly [number, number];
  maxAttempts?: number;
  readback?: 'field' | 'none';
  selectAllModifier?: 'auto' | 'Control' | 'Meta';
  inputMode?: BctlInteractionMode;
  scrollMode?: BctlInteractionMode;
  recoverTargetObstruction?: () => Promise<void>;
  timeout?: number;
};

export type BctlKeyOptions = BctlInteractionControl & {
  pressDelay?: number | readonly [number, number];
  timeout?: number;
};

export type BctlKeystrokeOptions = BctlInteractionControl & {
  keyDelay?: number | readonly [number, number];
  keyPressDelay?: number | readonly [number, number];
  timeout?: number;
};

export type BctlClickOptions = BctlLocatorClickOptions & BctlInteractionControl & {
  recoverTargetObstruction?: () => Promise<void>;
  rejectNewPages?: boolean;
  scrollMode?: BctlInteractionMode;
};

export type BctlScrollOptions = BctlInteractionControl & {
  recoverTargetObstruction?: () => Promise<void>;
  timeout?: number;
};

export type BctlClickResult = {
  position: {x: number; y: number};
  width: number;
  height: number;
  trajectoryPoints: number;
  hoverMs: number;
  pressMs: number;
  transport: 'cdp' | 'turbo';
};

export const BCTL_UNEXPECTED_PAGE = 'BCTL_UNEXPECTED_PAGE';

type Point = {x: number; y: number};
type NumberRange = number | readonly [number, number];
type KeyboardStroke = {
  code: string;
  key: string;
  keyCode: number;
  shift: boolean;
  text: string;
  unmodifiedText: string;
};

const pointerPositions = new WeakMap<Page, Point>();
const contextPointerPositions = new WeakMap<BrowserContext, Point>();
const HOVER_DELAY = [120, 320] as const;
const PRESS_DELAY = [72, 168] as const;
const HUMAN_WHEEL_DELTA_Y = 100;
/** BCTL DOM/交互默认跟随长生命周期浏览器任务；短探针必须由调用方显式传入。 */
const BCTL_ACTION_TIMEOUT = 12 * 60 * 60 * 1_000;
const CDP_COMMAND_ACK_GRACE_MS = 1_500;
const BCTL_INPUT_TIMING_KEY = '__bctlInputTiming';

function normalizeRange(value: unknown, fallback: [number, number], maximum: number): [number, number] {
  const source = Array.isArray(value) ? value : fallback;
  const first = Number(source[0]);
  const second = Number(source[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return [...fallback];
  const low = Math.max(0, Math.min(maximum, Math.round(first)));
  const high = Math.max(0, Math.min(maximum, Math.round(second)));
  return low <= high ? [low, high] : [high, low];
}

export function normalizeBctlInputTiming(value: unknown): BctlInputTiming {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    characterDelay: normalizeRange(candidate.characterDelay, DEFAULT_BCTL_INPUT_TIMING.characterDelay, 2_000),
    keyPressDelay: normalizeRange(candidate.keyPressDelay, DEFAULT_BCTL_INPUT_TIMING.keyPressDelay, 1_000),
    beforeInputDelay: normalizeRange(candidate.beforeInputDelay, DEFAULT_BCTL_INPUT_TIMING.beforeInputDelay, 10_000),
  };
}

function assertInteractionActive(signal?: AbortSignal, guard?: () => void): void {
  if (signal?.aborted) {
    const error = new Error('BCTL interaction aborted');
    error.name = 'AbortError';
    throw error;
  }
  guard?.();
}

function interactionGuard(options: BctlInteractionControl): () => void {
  return () => assertInteractionActive(options.signal, options.guard);
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'TimeoutError' || /\bTimeout\s+\d+ms exceeded\b/i.test(error.message)
  );
}

function isRetryableInteractionWait(error: unknown): boolean {
  return isPlaywrightTimeout(error) || (
    error instanceof Error && [
      'BCTL控件当前没有可命中的点击位置',
      'BCTL控件当前不可用',
    ].includes(error.message)
  );
}

async function runGuardedBctlAction<T>(
  action: (timeout: number) => Promise<T>,
  guard: (() => void) | undefined,
  timeout: number,
  waitMode: BctlWaitMode = 'bounded',
  sliceMs = 500,
): Promise<T> {
  if (waitMode === 'bounded') {
    guard?.();
    const result = await action(timeout);
    guard?.();
    return result;
  }
  const boundedSliceMs = Number.isFinite(sliceMs)
    ? Math.min(5_000, Math.max(100, Math.round(sliceMs)))
    : 500;
  while (true) {
    guard?.();
    try {
      const result = await action(boundedSliceMs);
      guard?.();
      return result;
    } catch (error) {
      guard?.();
      if (!isRetryableInteractionWait(error)) throw error;
      if (!isPlaywrightTimeout(error)) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, boundedSliceMs)));
      }
    }
  }
}

export function setBctlInputTiming(page: Page, value: unknown): void {
  (page as Page & {[BCTL_INPUT_TIMING_KEY]?: BctlInputTiming})[BCTL_INPUT_TIMING_KEY] =
    normalizeBctlInputTiming(value);
}

function bctlInputTiming(page: Page): BctlInputTiming {
  return (page as Page & {[BCTL_INPUT_TIMING_KEY]?: BctlInputTiming})[BCTL_INPUT_TIMING_KEY] ||
    normalizeBctlInputTiming(undefined);
}

async function runBoundedCdpOperation<T>(
  operation: () => Promise<T>,
  label: string,
  timeout = BCTL_ACTION_TIMEOUT,
  guard?: () => void,
): Promise<T> {
  // 超时只用于避免公共 API 永久占住调用方；具体 CDP session 由外层 finally 释放。
  void label;
  guard?.();
  const pending = operation();
  const result = timeout > 0
    ? await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => {
            const error = new Error(`${label}超时: ${timeout}ms`);
            error.name = 'TimeoutError';
            reject(error);
          }, timeout);
          void pending.finally(() => clearTimeout(timer)).catch(() => {});
        }),
      ])
    : await pending;
  guard?.();
  return result;
}

async function createBoundedCdpSession(
  page: Page,
  guard?: () => void,
  timeout = BCTL_ACTION_TIMEOUT,
): Promise<CDPSession> {
  return runBoundedCdpOperation(
    () => page.context().newCDPSession(page),
    'BCTL CDP 会话建立',
    timeout,
    guard,
  );
}

async function detachBoundedCdpSession(session: CDPSession): Promise<void> {
  // CDP 会话释放只是资源清理，不能反过来阻塞已经完成的页面业务阶段。
  // 发起后在后台收尾；断连或 Browser 关闭时忽略清理错误。
  void session.detach().catch(() => {});
}

async function sendBoundedCdpCommand(
  session: CDPSession,
  method: string,
  params: Record<string, unknown>,
  guard?: () => void,
): Promise<void> {
  guard?.();
  const command = (session.send as (
    command: string,
    parameters: Record<string, unknown>,
  ) => Promise<unknown>)(method, params);
  const acknowledgement = await Promise.race([
    command.then(
      () => ({kind: 'acknowledged' as const}),
      error => ({kind: 'rejected' as const, error}),
    ),
    new Promise<{kind: 'detached'}>(resolve =>
      setTimeout(() => resolve({kind: 'detached'}), CDP_COMMAND_ACK_GRACE_MS)
    ),
  ]);
  guard?.();
  if (acknowledgement.kind === 'rejected') throw acknowledgement.error;
  if (acknowledgement.kind === 'detached') {
    // Input.dispatch* 是无业务载荷回包。命令发出后若只丢了空 ACK，不得让后续
    // 选择、输入和阶段提交永久阻塞；各调用方继续用 URL、DOM 或字段读回判定结果。
    void command.catch(() => {});
  }
}

function randomBetween(value: NumberRange): number {
  if (typeof value === 'number') return value;
  return value[0] + Math.random() * (value[1] - value[0]);
}

function randomMilliseconds(value: NumberRange): number {
  return Math.max(0, Math.round(randomBetween(value)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function randomClickPosition(width: number, height: number): Point {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 2 || height <= 2) {
    throw new Error('BCTL控件没有有效的可点击区域');
  }
  const xRanges = [[0.18, 0.44], [0.56, 0.82]] as const;
  const xRange = xRanges[Math.floor(Math.random() * xRanges.length)] ?? [0.2, 0.8];
  return {
    x: width * randomBetween(xRange),
    y: height * randomBetween([0.22, 0.78]),
  };
}

async function bctlClickablePosition(
  locator: Locator,
  box: {width: number; height: number},
): Promise<Point> {
  const fragments = await locator.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.getClientRects())
      .map(rect => ({
        x: rect.left - bounds.left,
        y: rect.top - bounds.top,
        width: rect.width,
        height: rect.height,
      }))
      .filter(rect => rect.width > 2 && rect.height > 2);
  });
  const candidates = fragments.length
    ? fragments
    : [{x: 0, y: 0, width: box.width, height: box.height}];
  for (let attempt = 0; attempt < Math.max(12, candidates.length * 4); attempt += 1) {
    const fragment = candidates[Math.floor(Math.random() * candidates.length)]!;
    const inside = randomClickPosition(fragment.width, fragment.height);
    const position = {x: fragment.x + inside.x, y: fragment.y + inside.y};
    const hitsTarget = await locator.evaluate((element, point) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + point.x, bounds.top + point.y);
      return Boolean(hit && (hit === element || element.contains(hit)));
    }, position);
    if (hitsTarget) return position;
  }
  throw new Error('BCTL控件当前没有可命中的点击位置');
}

async function guardedWait(_page: Page, delay: NumberRange, guard?: () => void): Promise<number> {
  const milliseconds = randomMilliseconds(delay);
  guard?.();
  if (milliseconds > 0) await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
  guard?.();
  return milliseconds;
}

function bezierPoint(
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  t: number,
): Point {
  const inverse = 1 - t;
  return {
    x:
      inverse ** 3 * start.x +
      3 * inverse ** 2 * t * control1.x +
      3 * inverse * t ** 2 * control2.x +
      t ** 3 * end.x,
    y:
      inverse ** 3 * start.y +
      3 * inverse ** 2 * t * control1.y +
      3 * inverse * t ** 2 * control2.y +
      t ** 3 * end.y,
  };
}

function mouseTrajectory(start: Point, end: Point): Point[] {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance <= 4) return [{...end}];
  const steps = distance < 24
    ? clamp(Math.round(distance / 6), 2, 4)
    : clamp(Math.round(distance / 28) + randomMilliseconds([3, 8]), 4, 42);
  const perpendicularX = -deltaY / distance;
  const perpendicularY = deltaX / distance;
  const curve = Math.min(96, distance * randomBetween([0.05, 0.18])) *
    (Math.random() < 0.5 ? -1 : 1);
  const control1 = {
    x: start.x + deltaX * randomBetween([0.22, 0.38]) + perpendicularX * curve,
    y: start.y + deltaY * randomBetween([0.22, 0.38]) + perpendicularY * curve,
  };
  const control2 = {
    x: start.x + deltaX * randomBetween([0.62, 0.82]) - perpendicularX * curve * randomBetween([0.25, 0.7]),
    y: start.y + deltaY * randomBetween([0.62, 0.82]) - perpendicularY * curve * randomBetween([0.25, 0.7]),
  };
  const points: Point[] = [];
  for (let index = 1; index <= steps; index++) {
    const t = index / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    const point = bezierPoint(start, control1, control2, end, eased);
    const jitterLimit = Math.min(1.8, distance * 0.03);
    const jitter = index === steps ? 0 : (1 - t) * randomBetween([-jitterLimit, jitterLimit]);
    points.push({
      x: point.x + jitter,
      y: point.y + jitter * randomBetween([-0.65, 0.65]),
    });
  }
  points[points.length - 1] = {...end};
  return points;
}

async function dispatchMouseMove(
  session: CDPSession,
  page: Page,
  point: Point,
  guard?: () => void,
): Promise<void> {
  guard?.();
  await sendBoundedCdpCommand(session, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: 0,
    pointerType: 'mouse',
  }, guard);
  pointerPositions.set(page, {...point});
  contextPointerPositions.set(page.context(), {...point});
  guard?.();
}

async function initialPointerEntryPoint(page: Page, destination: Point): Promise<Point> {
  const viewport = await runBoundedCdpOperation(
    () => page.evaluate(() => ({
      width: Math.max(2, window.innerWidth || document.documentElement.clientWidth || 2),
      height: Math.max(2, window.innerHeight || document.documentElement.clientHeight || 2),
    })),
    'BCTL首次指针视口读取',
  ).catch(() => ({width: 1280, height: 720}));
  const inset = 2;
  const candidates = [
    {distance: destination.x, point: {x: inset, y: clamp(destination.y + randomBetween([-viewport.height * 0.1, viewport.height * 0.1]), inset, viewport.height - inset)}},
    {distance: viewport.width - destination.x, point: {x: viewport.width - inset, y: clamp(destination.y + randomBetween([-viewport.height * 0.1, viewport.height * 0.1]), inset, viewport.height - inset)}},
    {distance: destination.y, point: {x: clamp(destination.x + randomBetween([-viewport.width * 0.1, viewport.width * 0.1]), inset, viewport.width - inset), y: inset}},
    {distance: viewport.height - destination.y, point: {x: clamp(destination.x + randomBetween([-viewport.width * 0.1, viewport.width * 0.1]), inset, viewport.width - inset), y: viewport.height - inset}},
  ];
  const nearestDistance = Math.min(...candidates.map(candidate => candidate.distance));
  const nearest = candidates.filter(candidate => candidate.distance <= nearestDistance + 24);
  return nearest[Math.floor(Math.random() * nearest.length)]!.point;
}

async function movePointer(
  session: CDPSession,
  page: Page,
  destination: Point,
  guard?: () => void,
): Promise<number> {
  const start = pointerPositions.get(page) || contextPointerPositions.get(page.context());
  if (!start) {
    const entry = await initialPointerEntryPoint(page, destination);
    await dispatchMouseMove(session, page, entry, guard);
    await guardedWait(page, [35, 110], guard);
    const entryPoints = mouseTrajectory(entry, destination);
    for (const point of entryPoints) {
      await dispatchMouseMove(session, page, point, guard);
      await guardedWait(page, [7, 18], guard);
    }
    return entryPoints.length + 1;
  }
  const points = mouseTrajectory(start, destination);
  for (const point of points) {
    await dispatchMouseMove(session, page, point, guard);
    await guardedWait(page, [7, 18], guard);
  }
  return points.length;
}

async function dispatchHumanWheelBurst(
  session: CDPSession,
  page: Page,
  point: Point,
  direction: 1 | -1,
  wheelCount: number,
  guard?: () => void,
): Promise<number> {
  const requestedWheelCount = Math.max(1, Math.trunc(wheelCount));
  const pulseCount = Math.min(requestedWheelCount, randomMilliseconds([1, 3]));
  for (let pulse = 0; pulse < pulseCount; pulse += 1) {
    guard?.();
    await sendBoundedCdpCommand(session, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: direction * HUMAN_WHEEL_DELTA_Y,
      pointerType: 'mouse',
    }, guard);
    await guardedWait(page, [18, 52], guard);
  }
  await guardedWait(page, [70, 165], guard);
  return pulseCount;
}

type CdpScrollTargetState = {
  target: {top: number; bottom: number; left: number; right: number; width: number; height: number};
  viewport: {width: number; height: number};
  boundary: {
    kind: 'element' | 'page';
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
    scrollTop: number;
    maxScrollTop: number;
  };
  page: {scrollTop: number; maxScrollTop: number};
  boundaryVisibleHeight: number;
  pageDistanceY: number;
  targetDistanceY: number;
  visibleIntersection: {left: number; top: number; right: number; bottom: number; width: number; height: number};
  hitPoint: Point | undefined;
  canHit: boolean;
};

async function readCdpScrollTargetState(
  locator: Locator,
  timeout: number,
  guard?: () => void,
): Promise<CdpScrollTargetState> {
  return runBoundedCdpOperation(
    () => locator.evaluate(element => {
      const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
      const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      const pageScroller = (document.scrollingElement || document.documentElement) as HTMLElement;
      const pageMaxScrollTop = Math.max(0, pageScroller.scrollHeight - pageScroller.clientHeight);
      const targetRect = element.getBoundingClientRect();
      let scrollContainer: HTMLElement | undefined;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        const canScrollY = parent.scrollHeight > parent.clientHeight + 1 &&
          /^(?:auto|overlay|scroll)$/.test(style.overflowY);
        if (canScrollY) {
          scrollContainer = parent;
          break;
        }
      }
      const containerRect = scrollContainer?.getBoundingClientRect();
      const boundary = scrollContainer
        ? {
            kind: 'element' as const,
            top: containerRect?.top ?? 0,
            bottom: containerRect?.bottom ?? 0,
            left: containerRect?.left ?? 0,
            right: containerRect?.right ?? 0,
            width: Math.max(1, scrollContainer.clientWidth),
            height: Math.max(1, scrollContainer.clientHeight),
            scrollTop: Math.max(0, scrollContainer.scrollTop),
            maxScrollTop: Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight),
          }
        : {
            kind: 'page' as const,
            top: 0,
            bottom: viewportHeight,
            left: 0,
            right: viewportWidth,
            width: viewportWidth,
            height: viewportHeight,
            scrollTop: Math.max(0, pageScroller.scrollTop),
            maxScrollTop: pageMaxScrollTop,
          };
      const boundaryVisibleTop = Math.max(0, boundary.top);
      const boundaryVisibleBottom = Math.min(viewportHeight, boundary.bottom);
      const boundaryVisibleHeight = Math.max(0, boundaryVisibleBottom - boundaryVisibleTop);
      const effectiveBoundaryTop = boundary.kind === 'page' ? 0 : boundaryVisibleTop;
      const effectiveBoundaryBottom = boundary.kind === 'page' ? viewportHeight : boundaryVisibleBottom;
      const effectiveBoundaryHeight = Math.max(1, effectiveBoundaryBottom - effectiveBoundaryTop);
      // 只有被边缘裁切的控件才需要滚动；安全留白只用于裁切后的落点，不强迫已完整可见的控件居中。
      const margin = Math.min(48, Math.max(16, Math.floor(Math.min(effectiveBoundaryHeight, viewportHeight) * 0.06)));
      const pageDistanceY = boundary.kind === 'page'
        ? (targetRect.top < margin
            ? targetRect.top - margin
            : targetRect.bottom > viewportHeight - margin
              ? targetRect.bottom - (viewportHeight - margin)
              : 0)
        : (targetRect.top < margin
            ? targetRect.top - margin
            : targetRect.bottom > viewportHeight - margin
              ? targetRect.bottom - (viewportHeight - margin)
              : 0);
      const targetDistanceY = boundary.kind === 'page'
        ? pageDistanceY
        : targetRect.height >= effectiveBoundaryHeight - margin * 2
          ? (targetRect.top < effectiveBoundaryTop + margin
              ? targetRect.top - (effectiveBoundaryTop + margin)
              : 0)
          : (targetRect.top < effectiveBoundaryTop + margin
              ? targetRect.top - (effectiveBoundaryTop + margin)
              : targetRect.bottom > effectiveBoundaryBottom - margin
                ? targetRect.bottom - (effectiveBoundaryBottom - margin)
                : 0);
      const visibleLeft = Math.max(0, targetRect.left, boundary.left);
      const visibleTop = Math.max(0, targetRect.top, boundary.top);
      const visibleRight = Math.min(viewportWidth, targetRect.right, boundary.right);
      const visibleBottom = Math.min(viewportHeight, targetRect.bottom, boundary.bottom);
      const visibleIntersection = {
        left: visibleLeft,
        top: visibleTop,
        right: visibleRight,
        bottom: visibleBottom,
        width: Math.max(0, visibleRight - visibleLeft),
        height: Math.max(0, visibleBottom - visibleTop),
      };
      const hasIntersection = visibleIntersection.width >= 2 && visibleIntersection.height >= 2;
      const hitPoints = hasIntersection
        ? [
            {
              x: (visibleIntersection.left + visibleIntersection.right) / 2,
              y: (visibleIntersection.top + visibleIntersection.bottom) / 2,
            },
            {
              x: visibleIntersection.left + visibleIntersection.width * 0.25,
              y: (visibleIntersection.top + visibleIntersection.bottom) / 2,
            },
            {
              x: visibleIntersection.left + visibleIntersection.width * 0.75,
              y: (visibleIntersection.top + visibleIntersection.bottom) / 2,
            },
            {
              x: (visibleIntersection.left + visibleIntersection.right) / 2,
              y: visibleIntersection.top + visibleIntersection.height * 0.25,
            },
            {
              x: (visibleIntersection.left + visibleIntersection.right) / 2,
              y: visibleIntersection.top + visibleIntersection.height * 0.75,
            },
          ]
        : [];
      const hitPoint = hitPoints[0];
      const canHit = Boolean(
        hasIntersection &&
        hitPoints.some(pt => {
          const hit = document.elementFromPoint(pt.x, pt.y);
          return Boolean(hit && (hit === element || element.contains(hit)));
        })
      );
      return {
        target: {
          top: targetRect.top,
          bottom: targetRect.bottom,
          left: targetRect.left,
          right: targetRect.right,
          width: Math.max(0, targetRect.width),
          height: Math.max(0, targetRect.height),
        },
        viewport: {width: viewportWidth, height: viewportHeight},
        boundary,
        page: {
          scrollTop: Math.max(0, pageScroller.scrollTop),
          maxScrollTop: pageMaxScrollTop,
        },
        boundaryVisibleHeight,
        pageDistanceY,
        targetDistanceY,
        visibleIntersection,
        hitPoint,
        canHit,
      };
    }),
    'BCTL目标滚动状态读取',
    timeout,
    guard,
  );
}

function cdpScrollWheelPoint(state: CdpScrollTargetState, usePage: boolean): Point {
  if (usePage && state.boundary.kind === 'element') {
    const outsideX = state.boundary.left > 12
      ? state.boundary.left / 2
      : state.boundary.right < state.viewport.width - 12
        ? (state.boundary.right + state.viewport.width) / 2
        : undefined;
    const outsideY = state.boundary.top > 12
      ? state.boundary.top / 2
      : state.boundary.bottom < state.viewport.height - 12
        ? (state.boundary.bottom + state.viewport.height) / 2
        : undefined;
    if (outsideX !== undefined || outsideY !== undefined) {
      return {
        x: clamp(outsideX ?? state.viewport.width / 2, 2, state.viewport.width - 2),
        y: clamp(outsideY ?? state.viewport.height / 2, 2, state.viewport.height - 2),
      };
    }
  }
  const left = usePage ? 0 : state.boundary.left;
  const right = usePage ? state.viewport.width : state.boundary.right;
  const top = usePage ? 0 : state.boundary.top;
  const bottom = usePage ? state.viewport.height : state.boundary.bottom;
  return {
    x: clamp((left + right) / 2 + randomBetween([-12, 12]), 2, state.viewport.width - 2),
    y: clamp((top + bottom) / 2 + randomBetween([-10, 10]), 2, state.viewport.height - 2),
  };
}

function canReusePointerForCdpScroll(
  state: CdpScrollTargetState,
  usePage: boolean,
  point: Point,
): boolean {
  const insideViewport = point.x >= 2 && point.x <= state.viewport.width - 2 &&
    point.y >= 2 && point.y <= state.viewport.height - 2;
  if (!insideViewport) return false;
  if (state.boundary.kind === 'page') return true;
  const insideBoundary = point.x >= state.boundary.left && point.x <= state.boundary.right &&
    point.y >= state.boundary.top && point.y <= state.boundary.bottom;
  return usePage ? !insideBoundary : insideBoundary;
}

async function humanScrollTargetIntoViewWithCdp(
  locator: Locator,
  session: CDPSession,
  page: Page,
  timeout: number,
  guard?: () => void,
  recoverTargetObstruction?: () => Promise<void>,
): Promise<void> {
  let state = await readCdpScrollTargetState(locator, timeout, guard);
  let noProgressRounds = 0;
  for (let round = 0; round < 48; round += 1) {
    guard?.();
    const fullyVisible =
      state.visibleIntersection.width >= state.target.width - 0.5 &&
      state.visibleIntersection.height >= state.target.height - 0.5;
    if (state.canHit && fullyVisible) return;
    if (state.canHit && state.targetDistanceY === 0 && state.pageDistanceY === 0) return;
    if (state.visibleIntersection.width >= 2 && state.visibleIntersection.height >= 2 &&
      state.targetDistanceY === 0 && state.pageDistanceY === 0) {
      return;
    }

    let usePage = state.boundary.kind === 'page' || state.boundaryVisibleHeight < 8;
    let distance = usePage ? state.pageDistanceY : state.targetDistanceY;
    if (Math.abs(distance) < 1) {
      if (usePage && state.boundary.kind === 'element') {
        throw new Error('BCTL控件所在滚动容器无法进入视口');
      }
      throw new Error('BCTL控件滚动距离无法确定');
    }
    let direction = distance > 0 ? 1 : -1;
    const elementAtBoundary = state.boundary.kind === 'element' &&
      (direction > 0
        ? state.boundary.maxScrollTop - state.boundary.scrollTop <= 1
        : state.boundary.scrollTop <= 1);
    const pageHasCapacity = direction > 0
      ? state.page.maxScrollTop - state.page.scrollTop > 1
      : state.page.scrollTop > 1;
    if (!usePage && elementAtBoundary && pageHasCapacity) {
      usePage = true;
      distance = state.pageDistanceY;
      if (Math.abs(distance) < 1) throw new Error('BCTL控件父层滚动距离无法确定');
      direction = distance > 0 ? 1 : -1;
    }
    const activeScrollTop = usePage ? state.page.scrollTop : state.boundary.scrollTop;
    const activeMaxScrollTop = usePage ? state.page.maxScrollTop : state.boundary.maxScrollTop;
    if (direction > 0 && activeMaxScrollTop - activeScrollTop <= 1) {
      // 留白是滚动偏好，不是点击门槛；到边界时仍须确认目标能真实命中。
      // 后续 resolveCdpTarget / targetContainsPoint 会再次校验最终点击位置。
      if (state.canHit) return;
      throw new Error('BCTL控件滚动已到页面或容器底部');
    }
    if (direction < 0 && activeScrollTop <= 1) {
      if (state.canHit) return;
      throw new Error('BCTL控件滚动已到页面或容器顶部');
    }

    // 滚轮事件必须从鼠标当前所在坐标发生。当前坐标仍属于本轮滚动区域时直接
    // 沿用；只有页面与内层滚动容器切换、或布局变化使原坐标失效时才连续移动。
    let wheelPoint = pointerPositions.get(page) || contextPointerPositions.get(page.context());
    if (!wheelPoint || !canReusePointerForCdpScroll(state, usePage, wheelPoint)) {
      wheelPoint = cdpScrollWheelPoint(state, usePage);
      await movePointer(session, page, wheelPoint, guard);
    }
    await dispatchHumanWheelBurst(
      session,
      page,
      wheelPoint,
      direction as 1 | -1,
      Math.min(3, Math.max(1, Math.ceil(Math.abs(distance) / HUMAN_WHEEL_DELTA_Y))),
      guard,
    );
    const next = await readCdpScrollTargetState(locator, timeout, guard);
    const nextScrollTop = usePage ? next.page.scrollTop : next.boundary.scrollTop;
    const scrollProgress = Math.abs(nextScrollTop - activeScrollTop);
    const targetProgress = Math.abs(next.target.top - state.target.top);
    if (scrollProgress < 0.5 && targetProgress < 0.5) {
      noProgressRounds += 1;
    } else {
      noProgressRounds = 0;
    }
    if (noProgressRounds >= 3) {
      throw new Error('BCTL控件拟人滚动连续三轮没有进展');
    }
    state = next;
  }
  throw new Error('BCTL控件 CDP 拟人滚动超过 48 轮仍未到达');
}

/** 使用 CDP mouseWheel 将控件分段滚入真实视口，不调用 Playwright 的程序化滚动。 */
export async function bctlScrollIntoView(
  locator: Locator,
  options: BctlScrollOptions = {},
): Promise<void> {
  const page = locator.page();
  const guard = interactionGuard(options);
  const timeout = options.timeout ?? BCTL_ACTION_TIMEOUT;
  const session = await createBoundedCdpSession(page, guard, timeout);
  try {
    await humanScrollTargetIntoViewWithCdp(
      locator,
      session,
      page,
      timeout,
      guard,
      options.recoverTargetObstruction,
    );
  } finally {
    await detachBoundedCdpSession(session);
  }
}

async function targetContainsPoint(locator: Locator, point: Point): Promise<boolean> {
  return runBoundedCdpOperation(
    () => locator.evaluate((element, absolutePoint) => {
      const hit = document.elementFromPoint(absolutePoint.x, absolutePoint.y);
      return Boolean(hit && (hit === element || element.contains(hit)));
    }, point),
    'BCTL点击命中检测',
  );
}

async function resolveCdpTarget(
  locator: Locator,
  actionTimeout: number,
): Promise<{
  absolute: Point;
  position: Point;
  width: number;
  height: number;
}> {
  const box = await locator.boundingBox({timeout: actionTimeout});
  if (!box) throw new Error('BCTL控件没有可点击区域');
  const position = await runBoundedCdpOperation<Point>(
    () => bctlClickablePosition(locator, box),
    'BCTL点击位置解析',
    actionTimeout,
  );
  return {
    absolute: {x: box.x + position.x, y: box.y + position.y},
    position,
    width: box.width,
    height: box.height,
  };
}

async function resolveCdpTargetWithRecovery(
  locator: Locator,
  actionTimeout: number,
  recoverTargetObstruction?: () => Promise<void>,
) {
  try {
    return await resolveCdpTarget(locator, actionTimeout);
  } catch (error) {
    if (
      !recoverTargetObstruction ||
      !(error instanceof Error) ||
      error.message !== 'BCTL控件当前没有可命中的点击位置'
    ) throw error;
    await recoverTargetObstruction();
    return resolveCdpTarget(locator, actionTimeout);
  }
}

/**
 * 通用 BCTL 控件点击：默认 turbo；明确传入 human 时使用 CDP 拟人滚动与鼠标事件。
 * 包含多段曲线移动、悬停、微动和带按压时长的真实鼠标事件。
 * 这里不调用 locator.click()、page.mouse 或 Page.bringToFront。
 */
export async function bctlClick(
  locator: Locator,
  options: BctlClickOptions = {},
): Promise<BctlClickResult> {
  const page = locator.page();
  const guard = interactionGuard(options);
  const timeout = options.timeout ?? BCTL_ACTION_TIMEOUT;
  await runGuardedBctlAction(
    actionTimeout => locator.waitFor({state: 'visible', timeout: actionTimeout}),
    guard,
    timeout,
    options.waitMode,
  );
  if ((options.scrollMode ?? 'turbo') === 'turbo') {
    await runGuardedBctlAction(
      actionTimeout => locator.scrollIntoViewIfNeeded({timeout: actionTimeout}),
      guard,
      timeout,
      options.waitMode,
    );
    const box = await locator.boundingBox({timeout});
    if (!box) throw new Error('BCTL控件当前没有可点击区域');
    const createdPages: Page[] = [];
    const context = page.context();
    const recordCreatedPage = (createdPage: Page) => createdPages.push(createdPage);
    if (options.rejectNewPages) context.on('page', recordCreatedPage);
    try {
      await runGuardedBctlAction(
        actionTimeout => locator.click({
          force: options.force,
          noWaitAfter: options.noWaitAfter,
          timeout: actionTimeout,
          trial: options.trial,
        }),
        guard,
        timeout,
        options.waitMode,
      );
      if (options.rejectNewPages && createdPages.length) {
        await Promise.all(createdPages.map(createdPage => createdPage.close().catch(() => undefined)));
        throw new Error(`${BCTL_UNEXPECTED_PAGE}: ${createdPages.length}`);
      }
      return {
        position: {x: box.width / 2, y: box.height / 2},
        width: box.width,
        height: box.height,
        trajectoryPoints: 0,
        hoverMs: 0,
        pressMs: 0,
        transport: 'turbo',
      };
    } finally {
      if (options.rejectNewPages) context.off('page', recordCreatedPage);
    }
  }
  const session = await createBoundedCdpSession(page, guard, timeout);
  let trajectoryPoints = 0;
  let hoverMs = 0;
  let pressMs = 0;
  try {
    // human 只使用 CDP 滚轮，不叠加程序化滚动。
    await humanScrollTargetIntoViewWithCdp(
      locator,
      session,
      page,
      timeout,
      guard,
      options.recoverTargetObstruction,
    );
    if (!options.force) {
      await runGuardedBctlAction(
        async actionTimeout => {
          if (!(await locator.isEnabled({timeout: actionTimeout}))) {
            throw new Error('BCTL控件当前不可用');
          }
        },
        guard,
        timeout,
        options.waitMode,
      );
    }

    let target = await runGuardedBctlAction(
      actionTimeout => resolveCdpTargetWithRecovery(
        locator,
        actionTimeout,
        options.recoverTargetObstruction,
      ),
      guard,
      timeout,
      options.waitMode,
    );
    trajectoryPoints += await movePointer(session, page, target.absolute, guard);
    hoverMs += await guardedWait(page, HOVER_DELAY, guard);

    // 页面动画或布局重排后，用短轨迹修正到控件当前命中点。
    for (let attempt = 0; attempt < 3; attempt++) {
      const hitsTarget = await targetContainsPoint(locator, target.absolute).catch(() => false);
      if (hitsTarget || options.force) break;
      target = await runGuardedBctlAction(
        actionTimeout => resolveCdpTargetWithRecovery(
          locator,
          actionTimeout,
          options.recoverTargetObstruction,
        ),
        guard,
        timeout,
        options.waitMode,
      );
      trajectoryPoints += await movePointer(session, page, target.absolute, guard);
      hoverMs += await guardedWait(page, [70, 180], guard);
      if (attempt === 2 && !(await targetContainsPoint(locator, target.absolute).catch(() => false))) {
        throw new Error('BCTL控件被其他内容遮挡');
      }
    }

    // 沿用已经移动到的落点。只有原落点因布局重排而失效时才重新解析，并用完整
    // 轨迹移动到新落点；禁止在按下前重新随机落点后用单个 mouseMoved 瞬移过去。
    let finalTargetReady = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const hitsTarget = await targetContainsPoint(locator, target.absolute).catch(() => false);
      if (hitsTarget) {
        finalTargetReady = true;
        break;
      }
      if (attempt === 3) {
        finalTargetReady = Boolean(options.force);
        break;
      }
      target = await runGuardedBctlAction(
        actionTimeout => resolveCdpTargetWithRecovery(
          locator,
          actionTimeout,
          options.recoverTargetObstruction,
        ),
        guard,
        timeout,
        options.waitMode,
      );
      trajectoryPoints += await movePointer(session, page, target.absolute, guard);
      hoverMs += await guardedWait(page, [35, 95], guard);
    }
    if (!finalTargetReady) throw new Error('BCTL控件在最终点击前发生位移或被遮挡');

    if (!options.trial) {
      const createdPages: Page[] = [];
      const context = page.context();
      const recordCreatedPage = (createdPage: Page) => createdPages.push(createdPage);
      if (options.rejectNewPages) context.on('page', recordCreatedPage);
      guard();
      try {
        await sendBoundedCdpCommand(session, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: target.absolute.x,
          y: target.absolute.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          pointerType: 'mouse',
        }, guard);
        pressMs = await guardedWait(page, PRESS_DELAY, guard);
        await sendBoundedCdpCommand(session, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: target.absolute.x,
          y: target.absolute.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          pointerType: 'mouse',
        }, guard);
        guard();
        if (options.rejectNewPages) {
          await guardedWait(page, [80, 160], guard);
          if (createdPages.length) {
            await Promise.all(createdPages.map(createdPage => createdPage.close().catch(() => undefined)));
            throw new Error(`${BCTL_UNEXPECTED_PAGE}: ${createdPages.length}`);
          }
        }
      } finally {
        if (options.rejectNewPages) context.off('page', recordCreatedPage);
      }
    }
    pointerPositions.set(page, {...target.absolute});
    return {
      position: target.position,
      width: target.width,
      height: target.height,
      trajectoryPoints,
      hoverMs,
      pressMs,
      transport: 'cdp',
    };
  } finally {
    await detachBoundedCdpSession(session);
  }
}

const SHIFTED_DIGITS: Record<string, string> = {
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
};

const PUNCTUATION_KEYS: Record<string, {
  code: string;
  keyCode: number;
  unshifted: string;
  shift?: boolean;
}> = {
  '-': {code: 'Minus', keyCode: 189, unshifted: '-'},
  '_': {code: 'Minus', keyCode: 189, unshifted: '-', shift: true},
  '=': {code: 'Equal', keyCode: 187, unshifted: '='},
  '+': {code: 'Equal', keyCode: 187, unshifted: '=', shift: true},
  '[': {code: 'BracketLeft', keyCode: 219, unshifted: '['},
  '{': {code: 'BracketLeft', keyCode: 219, unshifted: '[', shift: true},
  ']': {code: 'BracketRight', keyCode: 221, unshifted: ']'},
  '}': {code: 'BracketRight', keyCode: 221, unshifted: ']', shift: true},
  '\\': {code: 'Backslash', keyCode: 220, unshifted: '\\'},
  '|': {code: 'Backslash', keyCode: 220, unshifted: '\\', shift: true},
  ';': {code: 'Semicolon', keyCode: 186, unshifted: ';'},
  ':': {code: 'Semicolon', keyCode: 186, unshifted: ';', shift: true},
  "'": {code: 'Quote', keyCode: 222, unshifted: "'"},
  '"': {code: 'Quote', keyCode: 222, unshifted: "'", shift: true},
  ',': {code: 'Comma', keyCode: 188, unshifted: ','},
  '<': {code: 'Comma', keyCode: 188, unshifted: ',', shift: true},
  '.': {code: 'Period', keyCode: 190, unshifted: '.'},
  '>': {code: 'Period', keyCode: 190, unshifted: '.', shift: true},
  '/': {code: 'Slash', keyCode: 191, unshifted: '/'},
  '?': {code: 'Slash', keyCode: 191, unshifted: '/', shift: true},
  '`': {code: 'Backquote', keyCode: 192, unshifted: '`'},
  '~': {code: 'Backquote', keyCode: 192, unshifted: '`', shift: true},
  ' ': {code: 'Space', keyCode: 32, unshifted: ' '},
};

function keyboardStrokeForCharacter(character: string): KeyboardStroke | undefined {
  if (/^[a-z]$/i.test(character)) {
    const upper = character.toUpperCase();
    return {
      code: `Key${upper}`,
      key: character,
      keyCode: upper.charCodeAt(0),
      shift: character === upper,
      text: character,
      unmodifiedText: character.toLowerCase(),
    };
  }
  if (/^\d$/.test(character)) {
    return {
      code: `Digit${character}`,
      key: character,
      keyCode: character.charCodeAt(0),
      shift: false,
      text: character,
      unmodifiedText: character,
    };
  }
  const shiftedDigit = SHIFTED_DIGITS[character];
  if (shiftedDigit) {
    return {
      code: `Digit${shiftedDigit}`,
      key: character,
      keyCode: shiftedDigit.charCodeAt(0),
      shift: true,
      text: character,
      unmodifiedText: shiftedDigit,
    };
  }
  const punctuation = PUNCTUATION_KEYS[character];
  if (!punctuation) return undefined;
  return {
    code: punctuation.code,
    key: character,
    keyCode: punctuation.keyCode,
    shift: punctuation.shift === true,
    text: character,
    unmodifiedText: punctuation.unshifted,
  };
}

async function dispatchModifier(
  session: CDPSession,
  type: 'rawKeyDown' | 'keyUp',
  modifier: 'Meta' | 'Control' | 'Shift',
  activeModifiers: number,
  guard?: () => void,
): Promise<void> {
  // 只发送 Chromium/Playwright 使用的 Windows VK；不要发送宿主原生键码。
  // Mac BCTL 的长期 Chrome 进程会把带 nativeVirtualKeyCode 的合成组合键误交给 AppKit 系统菜单。
  const definition = modifier === 'Meta'
    ? {code: 'MetaLeft', keyCode: 91}
    : modifier === 'Control'
      ? {code: 'ControlLeft', keyCode: 17}
      : {code: 'ShiftLeft', keyCode: 16};
  await sendBoundedCdpCommand(session, 'Input.dispatchKeyEvent', {
    type,
    key: modifier,
    code: definition.code,
    modifiers: activeModifiers,
    windowsVirtualKeyCode: definition.keyCode,
    location: 1,
  }, guard);
}

async function clearInput(
  session: CDPSession,
  page: Page,
  isMac: boolean,
  guard?: () => void,
): Promise<void> {
  const modifier = isMac ? 'Meta' : 'Control';
  const modifiers = isMac ? 4 : 2;
  guard?.();
  await dispatchModifier(session, 'rawKeyDown', modifier, modifiers, guard);
  await sendBoundedCdpCommand(session, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers,
    windowsVirtualKeyCode: 65,
    commands: ['SelectAll'],
  }, guard);
  await guardedWait(page, [30, 85], guard);
  await sendBoundedCdpCommand(session, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers,
    windowsVirtualKeyCode: 65,
  }, guard);
  await dispatchModifier(session, 'keyUp', modifier, 0, guard);
  await guardedWait(page, [45, 115], guard);
  await sendBoundedCdpCommand(session, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  }, guard);
  await guardedWait(page, [28, 78], guard);
  await sendBoundedCdpCommand(session, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  }, guard);
  guard?.();
}

async function typeCharacter(
  session: CDPSession,
  page: Page,
  character: string,
  keyDelay: NumberRange,
  guard: (() => void) | undefined,
  pressDelay: NumberRange,
): Promise<void> {
  const stroke = keyboardStrokeForCharacter(character);
  if (!stroke) {
    guard?.();
    await sendBoundedCdpCommand(session, 'Input.insertText', {text: character}, guard);
    await guardedWait(page, keyDelay, guard);
    return;
  }
  const modifiers = stroke.shift ? 8 : 0;
  if (stroke.shift) await dispatchModifier(session, 'rawKeyDown', 'Shift', modifiers, guard);
  guard?.();
  await sendBoundedCdpCommand(session, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: stroke.key,
    code: stroke.code,
    modifiers,
    text: stroke.text,
    unmodifiedText: stroke.unmodifiedText,
    windowsVirtualKeyCode: stroke.keyCode,
  }, guard);
  await guardedWait(page, pressDelay, guard);
  await sendBoundedCdpCommand(session, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: stroke.key,
    code: stroke.code,
    modifiers,
    windowsVirtualKeyCode: stroke.keyCode,
  }, guard);
  if (stroke.shift) await dispatchModifier(session, 'keyUp', 'Shift', 0, guard);
  await guardedWait(page, keyDelay, guard);
}

async function typeTextWithCdp(
  session: CDPSession,
  page: Page,
  value: string,
  keyDelay: NumberRange,
  keyPressDelay: NumberRange,
  guard?: () => void,
): Promise<void> {
  for (const character of String(value)) {
    await typeCharacter(session, page, character, keyDelay, guard, keyPressDelay);
    if (Math.random() < 0.025) await guardedWait(page, [360, 920], guard);
  }
}

/**
 * 在当前焦点控件中通过 CDP 逐键输入，不改变焦点或清空现有值。
 * 用于已经由调用方完成聚焦的组合框或文本控件。
 */
export async function bctlTypeKeystrokes(
  page: Page,
  value: string,
  options: BctlKeystrokeOptions = {},
): Promise<void> {
  const guard = interactionGuard(options);
  const timeout = options.timeout ?? BCTL_ACTION_TIMEOUT;
  const session = await createBoundedCdpSession(page, guard, timeout);
  const timing = bctlInputTiming(page);
  try {
    guard();
    await typeTextWithCdp(
      session,
      page,
      value,
      options.keyDelay ?? timing.characterDelay,
      options.keyPressDelay ?? timing.keyPressDelay,
      guard,
    );
    guard();
  } finally {
    await detachBoundedCdpSession(session);
  }
}

async function bctlPressKeyWithCdp(
  page: Page,
  key: {key: string; code: string; keyCode: number},
  options: BctlKeyOptions = {},
): Promise<void> {
  const guard = interactionGuard(options);
  const timeout = options.timeout ?? BCTL_ACTION_TIMEOUT;
  const session = await createBoundedCdpSession(page, guard, timeout);
  try {
    guard();
    await sendBoundedCdpCommand(session, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
    }, guard);
    await guardedWait(page, options.pressDelay ?? [55, 125], guard);
    await sendBoundedCdpCommand(session, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
    }, guard);
    guard();
  } finally {
    await detachBoundedCdpSession(session);
  }
}

/** 通过 CDP 发送真实 Tab 按下/抬起，用于关闭密码策略浮层并切换到确认框。 */
export async function bctlPressTab(
  page: Page,
  options: BctlKeyOptions = {},
): Promise<void> {
  return bctlPressKeyWithCdp(page, {key: 'Tab', code: 'Tab', keyCode: 9}, options);
}

/** 通过 CDP 发送真实 Escape 按下/抬起，用于关闭没有显式关闭按钮的验证浮层。 */
export async function bctlPressEscape(
  page: Page,
  options: BctlKeyOptions = {},
): Promise<void> {
  return bctlPressKeyWithCdp(page, {key: 'Escape', code: 'Escape', keyCode: 27}, options);
}

/**
 * 通用 BCTL 输入：默认 turbo；明确传入 human 时逐键输入，且只有旧值存在时才清空。
 */
export async function bctlInput(
  locator: Locator,
  value: string,
  options: BctlInputOptions = {},
): Promise<void> {
  const page = locator.page();
  const guard = interactionGuard(options);
  const timeout = options.timeout ?? BCTL_ACTION_TIMEOUT;
  const timing = bctlInputTiming(page);
  const expected = String(value);
  const maxAttempts = Math.max(1, Math.min(2, Math.trunc(options.maxAttempts ?? 2)));

  if ((options.inputMode ?? 'turbo') === 'turbo') {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      guard();
      if (options.scrollMode === 'human') {
        await bctlScrollIntoView(locator, {guard, timeout, waitMode: options.waitMode});
      } else {
        await runGuardedBctlAction(
          actionTimeout => locator.scrollIntoViewIfNeeded({timeout: actionTimeout}),
          guard,
          timeout,
          options.waitMode,
        );
      }
      await runGuardedBctlAction(
        actionTimeout => locator.fill(expected, {timeout: actionTimeout}),
        guard,
        timeout,
        options.waitMode,
      );
      if (options.readback === 'none') return;
      const actual = await locator.inputValue({timeout});
      const matches = options.comparison === 'digits'
        ? actual.replace(/\D/g, '') === expected.replace(/\D/g, '')
        : actual === expected;
      if (matches) return;
      if (attempt < maxAttempts) await options.recoverTargetObstruction?.();
    }
    throw new Error('BCTL字段 turbo 输入结果不一致');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    guard();
    await bctlClick(locator, {
      guard,
      noWaitAfter: true,
      recoverTargetObstruction: options.recoverTargetObstruction,
      scrollMode: options.scrollMode,
      timeout,
      waitMode: options.waitMode,
    });
    await guardedWait(page, options.beforeTypeDelay ?? timing.beforeInputDelay, guard);
    const focused = await runBoundedCdpOperation(
      () => locator.evaluate(element => element === document.activeElement),
      'BCTL输入焦点读取',
      timeout,
      guard,
    ).catch(() => false);
    if (!focused) {
      await bctlClick(locator, {
        guard,
        noWaitAfter: true,
        recoverTargetObstruction: options.recoverTargetObstruction,
        scrollMode: options.scrollMode,
        timeout,
        waitMode: options.waitMode,
      });
      await guardedWait(page, [180, 420], guard);
      const refocused = await runBoundedCdpOperation(
        () => locator.evaluate(element => element === document.activeElement),
        'BCTL输入二次焦点读取',
        timeout,
        guard,
      ).catch(() => false);
      if (!refocused) throw new Error('BCTL输入控件点击两次后仍未获得焦点');
    }

    const current = await locator.inputValue({timeout});
    const currentMatches = options.comparison === 'digits'
      ? current.replace(/\D/g, '') === expected.replace(/\D/g, '')
      : current === expected;
    if (currentMatches) return;

    const session = await createBoundedCdpSession(page, guard, timeout);
    try {
      // 清空快捷键取决于 Chrome 所在宿主，而不是页面指纹暴露的 navigator.platform。
      // Mac BCTL 会按业务指纹伪装成 Win32；沿用页面值会误发 Ctrl+A，旧值未选中后
      // 新手机号被直接追加。该模块运行在 Browser 的 Node 进程，可直接读取真实宿主。
      const useMeta = options.selectAllModifier === 'Meta' ||
        (options.selectAllModifier !== 'Control' && process.platform === 'darwin');
      if (current) await clearInput(session, page, useMeta, guard);
      await typeTextWithCdp(
        session,
        page,
        value,
        options.keyDelay ?? timing.characterDelay,
        options.keyPressDelay ?? timing.keyPressDelay,
        guard,
      );
    } finally {
      await detachBoundedCdpSession(session);
    }
    guard();
    if (options.readback === 'none') return;
    const actual = await locator.inputValue({timeout});
    const matches = options.comparison === 'digits'
      ? actual.replace(/\D/g, '') === expected.replace(/\D/g, '')
      : actual === expected;
    if (matches) return;
    if (attempt < maxAttempts) {
      if (options.recoverTargetObstruction) {
        await options.recoverTargetObstruction();
      }
    }
  }

  throw new Error('BCTL字段 CDP 输入结果不一致');
}
