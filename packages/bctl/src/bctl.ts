import type {Browser, BrowserContext, Page} from 'playwright';
import {connect as connectOverCdp} from './playwright.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:54345';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OPEN_INTERVAL_MS = 1_100;

export interface BrowserProfile {
  id: string;
  name: string;
  groupName?: string;
  groupId?: string | null;
  status?: number;
  seq?: number;
  remark?: string;
  [key: string]: any;
}

export interface CreateProfile {
  groupId?: string | null;
  name?: string;
  remark?: string;
  proxyMethod?: number;
  proxyType?: 'noproxy' | 'http' | 'https' | 'socks5' | 'ssh';
  browserFingerPrint?: Record<string, any>;
  host?: string;
  port?: string;
  proxyUserName?: string;
  proxyPassword?: string;
  password?: string;
  abortImageMaxSize?: number;
  abortMedia?: boolean;
  muteAudio?: boolean;
  credentialsEnableService?: boolean;
  [key: string]: any;
}

export interface OpenResult {
  id: string;
  ws: string;
  browser: Browser;
  page0: Page;
  context: BrowserContext;
  [key: string]: any;
}

export interface FilterOptions {
  groupId?: string;
  groupName?: string;
  name?: string;
  status?: number;
  [key: string]: any;
}

export interface BitBrowserApiResponse<T = unknown> {
  success: boolean;
  data: T;
  msg?: string;
  [key: string]: unknown;
}

export interface BitBrowserClientOptions {
  baseUrl?: string;
  minOpenIntervalMs?: number;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  connect?: typeof connectOverCdp;
}

export interface BitBrowserClient {
  create(options?: CreateProfile): Promise<string>;
  list(filter?: FilterOptions): Promise<BrowserProfile[]>;
  open(id: string | BrowserProfile): Promise<OpenResult>;
  close(id: string): Promise<BitBrowserApiResponse>;
  del(ids: string[]): Promise<BitBrowserApiResponse>;
  delname(name: string): Promise<BitBrowserApiResponse | undefined>;
  delgroup(groupName: string): Promise<BitBrowserApiResponse | number | undefined>;
  delopt(options?: FilterOptions): Promise<BitBrowserApiResponse | undefined>;
  delall(): Promise<BitBrowserApiResponse>;
  fastopen(filter?: string | FilterOptions): Promise<OpenResult[]>;
  fastclose(filter?: FilterOptions): Promise<BitBrowserApiResponse[]>;
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function createStartIntervalGate(minIntervalMs: number) {
  let tail = Promise.resolve();
  let nextStartAt = 0;

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    const slot = tail.then(async () => {
      const waitMs = Math.max(0, nextStartAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      nextStartAt = Date.now() + minIntervalMs;
    });
    tail = slot.catch(() => {});
    await slot;
    return task();
  };
}

function apiError(operation: string, response?: Partial<BitBrowserApiResponse>) {
  return new Error(`${operation}失败: ${response?.msg || '比特浏览器 API 无有效响应'}`);
}

export function createBitBrowserClient(options: BitBrowserClientOptions = {}): BitBrowserClient {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetch || globalThis.fetch;
  const connect = options.connect || connectOverCdp;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const gateOpen = createStartIntervalGate(options.minOpenIntervalMs ?? DEFAULT_OPEN_INTERVAL_MS);

  async function request<T>(path: string, body: unknown): Promise<BitBrowserApiResponse<T>> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`比特浏览器 API ${path} 请求失败 (${response.status}): ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as BitBrowserApiResponse<T>;
    } catch {
      throw new Error(`比特浏览器 API ${path} 返回了无效 JSON`);
    }
  }

  async function create(profileOptions: CreateProfile = {}): Promise<string> {
    const profile = {
      groupId: null,
      name: '',
      remark: 'API创建',
      proxyMethod: 2,
      proxyType: 'noproxy',
      browserFingerPrint: {},
      host: '',
      port: '',
      proxyUserName: '',
      proxyPassword: '',
      abortImageMaxSize: 10,
      abortMedia: true,
      muteAudio: true,
      credentialsEnableService: true,
      ...profileOptions,
    };
    const response = await request<{id: string}>('/browser/update', profile);
    if (!response.success || !response.data?.id) throw apiError('比特浏览器创建', response);
    console.log('比特浏览器创建成功', profile.name);
    return response.data.id;
  }

  async function open(id: string | BrowserProfile): Promise<OpenResult> {
    const browserId = typeof id === 'object' ? id.id : id;
    const response = await request<Record<string, any>>('/browser/open', {
      id: browserId,
      args: [],
      loadExtensions: false,
      extractIp: false,
    });
    if (!response.success || !response.data?.ws) throw apiError('打开浏览器', response);

    try {
      const {browser, context, page0} = await connect(response.data.ws);
      return {...response.data, browser, context, page0} as OpenResult;
    } catch (error) {
      await request('/browser/close', {id: browserId}).catch(() => {});
      throw error;
    }
  }

  async function list(filterOptions: FilterOptions = {}): Promise<BrowserProfile[]> {
    const allProfiles: BrowserProfile[] = [];
    const pageSize = 100;
    let currentPage = 0;

    while (true) {
      const response = await request<{list: BrowserProfile[]}>('/browser/list/concise', {
        page: currentPage,
        pageSize,
      });
      if (!response.success || !Array.isArray(response.data?.list)) throw apiError('获取浏览器列表', response);
      const pageProfiles = response.data.list;
      if (pageProfiles.length === 0) break;
      allProfiles.push(...pageProfiles);
      if (pageProfiles.length < pageSize) break;
      currentPage++;
    }

    if (Object.keys(filterOptions).length === 0) return allProfiles;
    return allProfiles.filter(profile =>
      Object.entries(filterOptions).every(([key, value]) => profile[key] == value),
    );
  }

  async function close(id: string): Promise<BitBrowserApiResponse> {
    return request('/browser/close', {id});
  }

  async function del(ids: string[]): Promise<BitBrowserApiResponse> {
    return request('/browser/delete/ids', {ids});
  }

  async function delall(): Promise<BitBrowserApiResponse> {
    return del((await list()).map(profile => profile.id));
  }

  async function delopt(filterOptions: FilterOptions = {}): Promise<BitBrowserApiResponse | undefined> {
    const profiles = await list(filterOptions);
    if (profiles.length === 0) {
      console.warn('警告：目标 option 无任何窗口。');
      return undefined;
    }
    console.log(`找到 ${profiles.length} 个窗口，执行删除...`);
    return del(profiles.map(profile => profile.id));
  }

  async function delgroup(groupName: string): Promise<BitBrowserApiResponse | number | undefined> {
    if (!groupName) {
      console.error('错误：必须提供要删除的分组名称 (groupName)。');
      return undefined;
    }
    const profiles = (await list()).filter(profile => profile.groupName === groupName);
    if (profiles.length === 0) {
      console.warn(`警告：找不到名为 "${groupName}" 的分组，或该分组下无任何窗口。`);
      return 0;
    }
    console.log(`在分组 "${groupName}" 中找到 ${profiles.length} 个窗口，执行删除...`);
    return del(profiles.map(profile => profile.id));
  }

  async function delname(name: string): Promise<BitBrowserApiResponse | undefined> {
    if (!name) {
      console.error('错误：必须提供要删除的窗口名称 (name)。');
      return undefined;
    }
    const profiles = (await list()).filter(profile => profile.name.includes(name));
    if (profiles.length === 0) {
      console.warn(`警告：找不到名称中包含 "${name}" 的窗口。`);
      return undefined;
    }
    console.log(`找到 ${profiles.length} 个名称匹配窗口，执行删除...`);
    return del(profiles.map(profile => profile.id));
  }

  async function fastopen(filter?: string | FilterOptions): Promise<OpenResult[]> {
    const filterOptions = typeof filter === 'string' ? {name: filter} : filter || {};
    const profiles = (await list(filterOptions)).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    console.log('fastopen:', profiles.length);
    const results = await Promise.all(
      profiles.map(profile =>
        gateOpen(() =>
          open(profile.id).catch(error => {
            console.error(`[Skip] ${profile.id} 启动失败: ${(error as Error).message}`);
            return undefined;
          }),
        ),
      ),
    );
    return results.filter((result): result is OpenResult => result !== undefined);
  }

  async function fastclose(filterOptions: FilterOptions = {}): Promise<BitBrowserApiResponse[]> {
    return Promise.all((await list(filterOptions)).map(profile => close(profile.id)));
  }

  return {create, list, open, close, del, delname, delgroup, delopt, delall, fastopen, fastclose};
}
