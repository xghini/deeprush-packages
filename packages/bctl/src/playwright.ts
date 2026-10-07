// src/playwright.ts
import {chromium, type Browser, type Page, type BrowserContext} from 'playwright';
import {createDefaultBrowserContext} from './default-context.js';

/**
 * 为本地 chromium 创建配置好的 context
 * - 设置超长 timeout
 * - 拦截图片/媒体/字体（验证码白名单除外）
 */
export async function createContext(browser: Browser): Promise<{context: BrowserContext; page: Page}> {
  const context = await createDefaultBrowserContext(browser);
  // context.setDefaultTimeout(25000);
  // context.setDefaultNavigationTimeout(25000);

  // 挂载路由规则：省流量 + 验证码白名单
  await context.route('**', route => {
    const req = route.request();
    const type = req.resourceType();
    // 放行非资源类 (API/Document/Script)
    if (!['image', 'media', 'font'].includes(type)) {
      return route.continue();
    }
    // 验证码白名单 (Google/AWS/Cloudflare/Geetest/Arkoselabs)
    const url = req.url();
    if (type === 'image' && /recaptcha|hcaptcha|turnstile|challenge|aws-waf|captcha|geetest|arkoselabs/i.test(url)) {
      return route.continue();
    }
    // 拦截其余所有图片、媒体、字体
    return route.abort();
  });

  const page = await context.newPage();
  return {context, page};
}

/** * 连接提供 ws 的指纹浏览器实例
 * 对应原来的 connect
 */
export async function connect(ws: string): Promise<{browser: Browser; context: BrowserContext; page0: Page}> {
  // 1. 连接浏览器 (timeout: 0 防止连接握手超时)
  const browser = await chromium.connectOverCDP(ws, {timeout: 0});
  const context = browser.contexts()[0] || (await createDefaultBrowserContext(browser));
  context.setDefaultTimeout(3_000_000);
  context.setDefaultNavigationTimeout(3_000_000);
  // 2. [全局拦截] 挂载路由规则：省流量 + 验证码白名单
  // 必须在操作页面前注入，确保新页面自动继承
  await context.route('**', route => {
    const req = route.request();
    const type = req.resourceType();
    // 放行非资源类 (API/Document/Script)
    if (!['image', 'media', 'font'].includes(type)) {
      return route.continue();
    }
    // 验证码白名单 (Google/AWS/Cloudflare/Geetest/Arkoselabs)
    const url = req.url();
    if (type === 'image' && /recaptcha|hcaptcha|turnstile|challenge|aws-waf|captcha|geetest|arkoselabs/i.test(url)) {
      return route.continue();
    }
    // 拦截其余所有图片、媒体、字体
    return route.abort();
  });

  // 3. [智能筛选] 寻找一个“正经”的可操作页面
  // 使用 for...of 循环以支持异步 title() 检查，排除 DevTools 和控制台
  let page0: Page | undefined;
  for (const p of context.pages()) {
    const u = p.url();
    // (A) 同步快筛：排除指纹浏览器控制台和空白页
    if (u.includes('console.bitbrowser.net') || u === 'about:blank') continue;

    // (B) 异步精筛：排除 DevTools 调试窗口
    try {
      const t = await p.title();
      if (t.includes('DevTools')) continue;

      page0 = p; // 找到目标，立即中断循环
      break;
    } catch (e) {
      continue; // 遍历期间页面若关闭，忽略报错继续找下一个
    }
  }

  // 若无可用页面，新建一个
  if (!page0) page0 = await context.newPage();
  return {browser, context, page0};
}
/**
 * 验证当前 Page 的网络/代理通畅性
 * @param page Playwright Page 对象
 * @param testUrl 测试目标 (默认 Google robots.txt，极小且无 JS)
 */
export async function verifyNetwork(page: Page, testUrl = 'https://www.google.com/robots.txt'): Promise<void> {
  try {
    // waitUntil: 'commit' 足以此判断网络连通性，比 domcontentloaded 快
    const res = await page.goto(testUrl, {timeout: 10_000, waitUntil: 'commit'});
    const status = res?.status();

    // 这里的 title 获取可能需要稍等，但 robots.txt 通常瞬间渲染
    // 如果是普通页面，建议保留原有的 title 检查逻辑
    const title = await page.title();

    // 逻辑合并：非 200/304 或 标题含错误关键词即视为失败
    if ((status !== 200 && status !== 304) || /BitBrowser|Error|无法访问/i.test(title)) {
      throw new Error(`状态码: ${status} | 标题: ${title}`);
    }
  } catch (e: any) {
    // 抛出干净的错误信息，由调用方决定是否关闭浏览器
    throw new Error(`PROXY_FAIL: ${e.message}`);
  }
}
