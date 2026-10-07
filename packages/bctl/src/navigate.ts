// src/navigate.ts
import type {Page} from 'playwright';

export interface SafeGotoOptions extends NonNullable<Parameters<Page['goto']>[1]> {
  /** 重试次数，默认 1 */
  retries?: number;
}

/** 延迟指定毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 健壮的页面导航，自动重试网络错误
 * @param page - Playwright Page
 * @param url - 目标 URL
 * @param options - goto 选项 + retries
 * @returns 是否成功
 */
export async function safeGoto(page: Page, url: string, options?: SafeGotoOptions): Promise<boolean> {
  const {retries = 1, ...gotoOptions} = options || {};
  for (let i = 0; i <= retries; i++) {
    try {
      await page.goto(url, gotoOptions);
      return true;
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('net::ERR_') && i < retries) {
        console.warn(`[safeGoto] 第${i + 1}次失败: ${msg.split(' ')[0]}, 重试...`);
        await sleep(1000);
        continue;
      }
      console.error(`[safeGoto] ${url} 失败:`, msg.split('\n')[0]);
      return false;
    }
  }
  return false;
}
