// src/helpers.ts
import type {Page} from 'playwright';

/**
 * 格式化时间戳字符串 (YYMMDD-HHmmss)
 * @returns 格式化的时间戳字符串
 */
export function dateString(): string {
  return new Date()
    .toLocaleString('sv')
    .replace(/[-T: ]/g, '')
    .replace(/^\d{2}(\d{6})/, '$1-');
}

/**
 * 使用 CDP 将浏览器窗口置前。只用于用户明确要求的激活；后台步骤不得调用（见 README「Live sessions」）。
 * @param page - Playwright Page
 */
export async function bringToFront(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Page.bringToFront');
}
