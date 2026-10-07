# Cloudflare CDP：ITDOG 权威路线

## 当前决策

`src/cloudflare-cdp.ts` 是全局唯一的 Cloudflare checkbox 基础输入实现，算法以已经在
ITDOG 业务主链运行的子 Frame 路线为准。ITDOG 也必须反向消费该公开能力，不能保留
一份内联副本。

## 不变量

1. 从 `page.frames()` 找到 URL 命中 Cloudflare Turnstile/challenge-platform 的子 Frame。
2. `context.newCDPSession(frame)` 直接连接该子 Frame；不为 Cloudflare checkbox 创建
   Page CDP 会话。
3. 在子 Frame 会话执行 `DOM.getDocument({depth: -1, pierce: true})`，遍历普通子节点、
   shadow roots、pseudo elements、content document 与 template content，定位真实的
   `INPUT[type=checkbox]`。
4. 用 checkbox 自身的 `backendNodeId` 读取 `DOM.getBoxModel`；点击点固定为节点左边界
   加 12px、垂直中心。
5. move、press、release 都在同一个子 Frame 会话发送，move 到 press 等待 120ms，
   press 到 release 等待 90ms。
6. 一个 clicker 对应一个挑战循环。同一 Frame 对象只在成功 release 后记为已点击；
   布局尚未出现或发送失败仍允许重试。Cloudflare 重签并替换 Frame 后，新 Frame 可处理。
7. 子 Frame 会话保持到 clicker `dispose()`，由调用方在业务生命周期结束时释放。

## 明确排除

- Page 会话读取外层 iframe box 后用固定偏移猜 checkbox 坐标。
- Accessibility/AX 树作为 checkbox 定位路径。
- 双次几何签名、点击前截图或哈希作为允许点击的前置条件。
- 在消费者内复制 CDP/DOM/checkbox/鼠标事件实现。
- 当权威路线失败时静默切换到另一套点击算法。

页面打开、轮询频率、挑战是否出现、正常页面识别、超时和通过/失败判定都属于消费
方编排，不进入 BCTL 基础输入能力。
