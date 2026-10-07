import type {Locator, Page} from 'playwright';

export type HumanRange = readonly [min: number, max: number];
type LocatorClickOptions = NonNullable<Parameters<Locator['click']>[0]>;

export type HumanClickOptions = Omit<LocatorClickOptions, 'position' | 'delay'> & {
  xRanges?: readonly HumanRange[];
  yRange?: HumanRange;
  delay?: number | HumanRange;
  waitForVisible?: boolean;
  focus?: boolean;
  scrollIntoView?: boolean;
  requireBoundingBox?: boolean;
  guard?: () => void;
  /**
   * One budget for the whole click (wait, scroll, focus, measure, click): each step gets what is left.
   * Without it each step may take `timeout` on its own, several times over (a caller that gave up on its
   * own deadline could still see the click land later).
   */
  totalTimeout?: number;
};

export interface HumanClickResult {
  position: {x: number; y: number};
  width: number;
  height: number;
}

export interface HumanTypeOptions {
  keyDelay?: number | HumanRange;
  beforeDelay?: number | HumanRange;
  afterClearDelay?: number | HumanRange;
  afterDelay?: number | HumanRange;
  pauseChance?: number;
  pauseDelay?: number | HumanRange;
  waitForVisible?: boolean;
  focus?: boolean;
  clear?: boolean | 'fill';
  timeout?: number;
  guard?: () => void;
}

export interface HumanKeyboardTypeOptions {
  keyDelay?: number | HumanRange;
  pauseChance?: number;
  pauseDelay?: number | HumanRange;
  guard?: () => void;
}

function randomBetween(range: number | HumanRange): number {
  if (typeof range === 'number') return range;
  const [min, max] = range;
  return min + Math.random() * (max - min);
}

function randomMilliseconds(range: number | HumanRange): number {
  return Math.max(0, Math.round(randomBetween(range)));
}

function sleep(milliseconds: number | HumanRange): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, randomMilliseconds(milliseconds)));
}

function pickRange(ranges: readonly HumanRange[]): HumanRange {
  return ranges[Math.floor(Math.random() * ranges.length)] ?? [0.2, 0.8];
}

export function randomHumanClickPosition(
  width: number,
  height: number,
  xRanges: readonly HumanRange[] = [[0.2, 0.8]],
  yRange: HumanRange = [0.2, 0.8],
): {x: number; y: number} {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 2 || height <= 2) {
    throw new Error('控件没有有效的可点击区域');
  }
  return {
    x: width * randomBetween(pickRange(xRanges)),
    y: height * randomBetween(yRange),
  };
}

/**
 * 在控件内部选择非固定落点，并保留 Playwright Locator 的可见、稳定、未遮挡检查。
 */
export async function humanClick(
  locator: Locator,
  options: HumanClickOptions = {},
): Promise<HumanClickResult | undefined> {
  const {
    xRanges = [[0.2, 0.8]],
    yRange = [0.2, 0.8],
    delay = [50, 150],
    waitForVisible = true,
    focus = true,
    scrollIntoView = false,
    requireBoundingBox = false,
    guard,
    totalTimeout,
    ...clickOptions
  } = options;
  const deadline = totalTimeout === undefined ? undefined : Date.now() + totalTimeout;
  // Without a total budget each step keeps the caller's own timeout, as before.
  const timeout = () => deadline === undefined ? clickOptions.timeout : Math.max(1, deadline - Date.now());
  guard?.();
  if (waitForVisible) await locator.waitFor({state: 'visible', timeout: timeout()});
  guard?.();
  if (scrollIntoView) await locator.scrollIntoViewIfNeeded({timeout: timeout()});
  guard?.();
  if (focus) await locator.focus({timeout: timeout()});
  guard?.();
  const box = await locator.boundingBox({timeout: timeout()});
  guard?.();
  if (!box) {
    if (requireBoundingBox) throw new Error('控件没有有效的可点击区域');
    await locator.click({...clickOptions, timeout: timeout(), delay: randomMilliseconds(delay)});
    return undefined;
  }
  const position = randomHumanClickPosition(box.width, box.height, xRanges, yRange);
  await locator.click({...clickOptions, timeout: timeout(), position, delay: randomMilliseconds(delay)});
  guard?.();
  return {position, width: box.width, height: box.height};
}

/**
 * 逐字符输入；数字第三参数保留旧版“额外前置延迟”语义，配置对象可复用到具体业务流程。
 */
export async function humanType(
  locator: Locator,
  value: string,
  delayOrOptions: number | HumanTypeOptions = 0,
): Promise<void> {
  const options: HumanTypeOptions = typeof delayOrOptions === 'number'
    ? {beforeDelay: 200 + delayOrOptions}
    : delayOrOptions;
  const {
    keyDelay = [20, 100],
    beforeDelay = 200,
    afterClearDelay = 200,
    afterDelay = [100, 300],
    pauseChance = 0.015,
    pauseDelay = [800, 1_600],
    waitForVisible = false,
    focus = true,
    clear = true,
    timeout,
    guard,
  } = options;
  guard?.();
  if (waitForVisible) await locator.waitFor({state: 'visible', timeout});
  guard?.();
  if (focus) await locator.focus({timeout});
  guard?.();
  if (beforeDelay) await sleep(beforeDelay);
  guard?.();
  if (clear === 'fill') await locator.fill('', {timeout});
  else if (clear) await locator.clear({timeout});
  guard?.();
  if (afterClearDelay) await sleep(afterClearDelay);
  for (const character of String(value)) {
    guard?.();
    await locator.pressSequentially(character, {delay: randomMilliseconds(keyDelay), timeout});
    guard?.();
    if (pauseChance > 0 && Math.random() < pauseChance) await sleep(pauseDelay);
  }
  guard?.();
  if (afterDelay) await sleep(afterDelay);
  guard?.();
}

/** 在已经获得焦点的控件上逐字符发送键盘事件。 */
export async function humanKeyboardType(
  page: Page,
  value: string,
  options: HumanKeyboardTypeOptions = {},
): Promise<void> {
  const {
    keyDelay = [20, 100],
    pauseChance = 0,
    pauseDelay = [800, 1_600],
    guard,
  } = options;
  guard?.();
  for (const character of String(value)) {
    guard?.();
    await page.keyboard.type(character);
    guard?.();
    await page.waitForTimeout(randomMilliseconds(keyDelay));
    if (pauseChance > 0 && Math.random() < pauseChance) await page.waitForTimeout(randomMilliseconds(pauseDelay));
  }
  guard?.();
}
