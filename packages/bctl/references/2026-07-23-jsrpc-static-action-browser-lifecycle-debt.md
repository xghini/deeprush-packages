# 2026-07-23 JSRPC 静态 action 与 browser 会话生命周期技术债

## 状态

- 记录日期：2026-07-23。
- 所有者：`@deeprush/bctl` 的远程执行边界；消费方包括 `C:\$\main\node\project\aws` 的 `ctl.ts` / `browser.ts`。
- 当前缓解：AWS CTL 的 Oracle `/login` 已由 CTL 在 JSRPC 回调内按版本动态导入登录实现，更新该路径只需重载 CTL。
- 未清债：BCTL 尚无一等的远端 action 版本/模块注册协议；其他消费方仍可能引用 browser 启动时静态导入的业务 action。

## 已确认的执行边界

`@deeprush/bctl` 的 `createRemoteCtl` 把回调 `toString()` 后连同 `remoteData` 发给远端。AWS browser worker 再对源码执行 `eval`。因此：

1. 调用端闭包不会被传输；动态数据只能显式放进 `remoteData`。
2. 回调中的自由标识符不属于 CTL 进程，而是在 browser worker 的 `eval` 作用域中解析。
3. 当回调写 `action.actionOracleLogin(...)` 时，`action` 是 browser 启动时静态导入的模块实例。
4. 只重载 CTL 或只改磁盘上的 `_action.ts`，不会替换 browser 内已经加载的静态 `action`。
5. 重载 browser 虽能加载新模块，却会关闭该进程持有的全部 `BrowserContext` 和页面；它不是普通业务 action 更新应付出的代价。

这不是闭包限制的同义反复。闭包限制解决“数据如何传输”，本技术债解决“业务实现由哪个进程加载、何时更新、更新时是否破坏活会话”。

## 现场经过与真实证据

Oracle 新账号登录会在密码通过后强制进入 `Enable Secure Verification`。2026-07-23，首次实现把“选择 Mobile App → 开启 Offline Mode → 读取 TOTP 密钥 → 验证 → 回写账号”直接加入 AWS `_action.ts`，随后为加载静态模块重载了 browser。结果是既有窗口被关闭，用户随后点击 CTL `login` 时看不到业务窗口，暴露了静态 action 更新与有状态 browser 生命周期的错误耦合。

修正后的 Oracle 路径由 CTL 下发如下版本化动态导入，再调用对应 action：

```ts
const oracleActions = await import(
  './api/_action.ts?bridge=oracle-login-first-mfa-20260723a'
);
await oracleActions.actionOracleLogin(page, account);
```

用户指定 Oracle 新账号的验证结果（本记录不保留账号凭据标识）：

- 首次 `/login` 自动完成 MFA 注册，数据库按唯一账号 key 回读到 26 位 MFA；
- 页面进入 `https://cloud.oracle.com/identity/domains/my-profile/auth-tokens?...`，标题为 `My profile | Oracle Cloud Infrastructure`；
- 运行日志连续出现“Oracle 首次 MFA 已自动注册并回写”和“Oracle 登录操作完成”；
- 迁移加载边界时只重载 CTL，browser PID 前后不变；重载前后目标页面数和总页面数均为 `1`；
- 再次调用真实 `/login` 后目标页面数从 `1` 增加到 `2`，browser PID 不变，两个页面最终都到达 auth-tokens。

## 目标边界

- browser worker 是长期存活的会话所有者，只负责 Playwright/CDP、页面、Context 和宿主能力。
- CTL 是业务编排与版本选择者；变化频繁的 provider 登录实现应由 CTL 在远端回调中按显式版本动态加载，或通过未来的 action registry 解析。
- 业务 action 更新不得以重启 browser 作为正常部署方式。只有 browser 宿主、CDP 连接、执行协议或无法热替换的核心能力发生变化时，才需要重启 browser。
- 数据库回写必须精确绑定本次账号 key，并在第三方 MFA 生效前持久化候选密钥、成功后再次读回；日志不得输出密钥。
- 发布或切换实现时，至少读回 browser PID、目标页面数和最终业务落点，不能用 CTL HTTP 204 或 PM2 online 代替结果。

## 待清债方向

BCTL 应提供一等的远端 action 描述与加载协议，避免每个消费项目手写查询串：

```ts
type RemoteActionRef = {
  module: string;
  version: string;
  exportName: string;
};
```

执行端按允许的模块根目录和 `module + version` 缓存，控制端显式选择版本。协议需要保留现有 `remoteData` 传输，不把本地闭包或任意模块路径隐式带入远端。在该能力落地前，消费项目使用带版本号的动态 `import()`，并把版本选择留在 CTL 侧。
