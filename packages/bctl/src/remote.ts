// src/remote.ts
/**
 * remoteCtl 远程执行框架
 *
 * ⚠️ 重要：这是一个非常规的远程执行方案，使用前必须理解其工作原理。
 *
 * 工作原理：
 * 1. 将本地函数序列化为字符串发送到远程服务器
 * 2. 远程服务器 eval 执行该函数
 * 3. remoteData 作为全局变量注入到远程环境
 *
 * ⚠️ 核心限制：闭包变量不可用！
 * 远程函数会被序列化为字符串发送，闭包变量在序列化时丢失。
 * 必须使用 `remoteData` 作为变量名传递数据。
 *
 * @example
 * // ❌ 错误：闭包变量 validLinks 在远程端是 undefined
 * const validLinks = [{email: 'a@test.com'}];
 * await remoteCtl(async (pages) => {
 *   for (const item of validLinks) {} // ❌ validLinks 是 undefined
 * }, validLinks);
 *
 * // ✅ 正确：必须使用 remoteData 作为变量名
 * const remoteData = [{email: 'a@test.com'}];
 * await remoteCtl(async (pages) => {
 *   for (const item of remoteData) {} // ✅ remoteData 由远程端注入
 * }, remoteData);
 */

import type {Browser, BrowserContext, Page} from 'playwright';

/** 远程函数签名 */
export type RemoteFn<T = unknown> = (pages: Page[], contexts: BrowserContext[], browser: Browser) => Promise<T>;

export interface RemoteCtlOptions {
  /** 远程服务器 URL，默认 http://127.0.0.1:3175/remoteCtl */
  serverUrl?: string;
  /** 超时时间（毫秒），默认 86400000 (24小时) */
  timeout?: number;
  /** 是否注入 getOrCreatePage 函数，默认 false（由调用方自行注入） */
  injectPageManager?: boolean;
  /** 自定义 fetch 实现，主要用于宿主环境或测试 */
  fetch?: typeof globalThis.fetch;
}
const DEFAULT_OPTIONS = {
  // serverUrl: 'http://192.168.5.9:3175/remoteCtl',
  serverUrl: 'http://127.0.0.1:3175/remoteCtl',
  timeout: 24 * 60 * 60 * 1000,
  injectPageManager: false,
} satisfies Omit<Required<RemoteCtlOptions>, 'fetch'>;

/**
 * 创建远程执行器
 *
 * 远程端可用的注入：
 * - pages: Page[] - 所有已打开的页面
 * - contexts: BrowserContext[] - 所有浏览器上下文
 * - browser: Browser - 浏览器实例
 * - remoteData: unknown - 传入的数据参数
 * - 宿主进程主动注入的工具和业务模块
 * - action.*: 业务操作函数
 * - basic.*: 基础工具函数
 *
 * @param options - 配置选项
 * @returns remoteCtl 函数
 * @example
 * const remoteCtl = createRemoteCtl();
 * const remoteData = {email: 'test@example.com'};
 * const result = await remoteCtl(async (pages, contexts, browser) => {
 *   const page = pages.find(p => p.name === remoteData.email);
 *   if (!page) return {found: false};
 *   return {found: true, title: await page.title()};
 * }, remoteData);
 */
export function createRemoteCtl(options?: RemoteCtlOptions) {
  const opts = {...DEFAULT_OPTIONS, ...options};
  const fetchImpl = options?.fetch || globalThis.fetch;

  return async function remoteCtl<T = unknown>(remoteFn: RemoteFn<T>, remoteData: unknown): Promise<T> {
    const fnStr = remoteFn.toString();

    const response = await fetchImpl(opts.serverUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        remoteFn: fnStr,
        remoteData
      }),
      signal: AbortSignal.timeout(opts.timeout)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`远程执行失败 (${response.status}): ${text}`);
    }

    const res = await response.json();

    // 检查远程服务错误
    if (res && typeof res === 'object' && 'code' in res && (res as any).code >= 400) {
      throw new Error(`远程执行失败: ${(res as any).message || JSON.stringify(res)}`);
    }

    return res as T;
  };
}
