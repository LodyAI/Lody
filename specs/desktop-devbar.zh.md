# Desktop 性能栏

Status: draft
Translation: current

[English](desktop-devbar.md)

## 场景

开发者排查 Desktop 响应问题时，可以在窗口底部持续查看性能指标，包括打包版本。
他们可以打开 Devframe 官方 Hub 浮层来排查主线程卡顿，使用检查、无障碍和终端工具，
让编码 Agent 读取相同诊断信息，或通过深链接打开性能视图。内容区域会为底栏预留高度，
避免遮挡输入框。

## 行为

Devbar 随 Dev、Staging 和 Prod 构建发布，但每次进程启动时默认关闭。Desktop 的
Settings > About 中，隐藏的 Developer Mode 会显示“打开 Devbar”控件。点击后会启动本地
Hub，并在保留路由的情况下把主窗口重载到 Devbar renderer 入口；“停止 Devbar”会关闭
Hub 并返回普通 renderer 入口。辅助窗口不会加载 Devbar 入口。`LODY_DEVBAR=true` 仅保留
为启动前自动开启的测试覆盖，不是产品使用的必要条件，也不选择云部署或改变平台组合。

右侧显示 renderer 动画回调 FPS、排除近期输入的 CLS 最大会话窗口、最近采样区间的
Long Task 时长，以及 Electron 进程汇总 CPU 与常驻内存。`Heap xxxM` 是 Chromium
当前 renderer 的 JS heap 估算值，不包括其他 worker/renderer。应用启动后才打开 Devbar
时，该值带 `~` 前缀，因为 Chromium 精确内存开关只能在 app ready 前设置；自动化覆盖
会在启动时启用精确读数。`GPU xx% xxxM` 表示 GPU 进程 CPU 和常驻内存，不表示 GPU
硬件利用率或 VRAM。Electron 汇总不包括外部 CLI/Agent 进程，并可能重复计算共享内存页。

选择 `DEVBAR` 会在用户应用内加载的 Devframe 官方 Hub UI 中激活 Main Thread。
Hub 的 loopback 根地址也提供相同的独立 viewer，并包含 Main Thread、Devframe
Inspector、Accessibility Inspector、命令面板、设置和 dock 控件。只有开启独立的 Agent
与终端能力后才会出现 Terminals。Main Thread 使用 Devframe 官方 JSON-render renderer
和 `@antfu/design` 组件；Lody 不维护另一套详细界面样式。

性能视图首先展示当前 FPS、CPU、heap 和阻塞时间卡片，之后是可折叠的当前指标、
阻塞汇总和 Chromium Performance Timeline 报告的有界近期 Long Tasks。Devframe 1.0
官方 JSON-render catalog 没有 chart primitive，因此 Main thread dock 是一个
`custom-render` 条目：loopback server 提供一个小型 Lody 自有模块，在同一 dock 内
挂载官方 JSON-render 视图并在其下方追加 canvas 趋势卡，每秒轮询一次快照 JSON 路由，
绘制 FPS、CPU、heap、常驻内存与阻塞时间的实时折线图。这是对“不维护另一套详细界面样式”
边界的有限例外：它在原生视图内增加 chart 展示面，而不是并行的视图样式表。
Long Task 证明 renderer 主线程至少阻塞 50 ms，但不包含 JavaScript 调用栈；
函数归因仍需后续 CPU profile。`lody://devbar?view=main-thread`（或安装配置对应协议）
只在 Devbar 已启用时聚焦 Desktop 并打开该视图；深链接本身不会授予能力。

指标在窗口可见时约每秒刷新一次。禁用时不采样也不监听网络；窗口隐藏时暂停动画回调
和进程轮询。不可用指标和 CPU 预热显示破折号。测量仅保存在内存，不产生遥测或持久化。
Devbar 故障降级为无诊断而不影响应用本身：Hub 请求错误以 HTTP 错误作答，渲染端故障
只移除该底栏。

## 会话采集

已启用的底栏提供 **Capture chat**，可在进入会话前点击。采集会同步在当前 renderer
启动，显示正在记录的状态，并提供 **Stop capture**，结束后提供 **Copy capture**。
它不重启应用、不需要调试端口、不清理缓存，也不声称已经冷进入。排查冷进入时，
应先启用 Devbar，再在选择目标会话前开始采集；启用 Devbar 会重新加载主 renderer。

采集仅在主动开启后逐动画帧观察会话视口，保留发生变化的样本，区分首次显示、显示后
重新隐藏、视口移除或替换、可见行消失，以及滚动偏移不变时保留阅读行的位置变化。
Long Task 区间、输入种类和最大帧回调间隔使用同一相对时钟。这些是观察结果，不是闪烁
成因的证明：不采集实际呈现像素、JavaScript 调用栈或内部源/投影身份；正常布局变化
也可能造成阅读行位移。

采集在 60 秒后、达到 1,800 个变化样本、主动停止、窗口隐藏、卸载或采样异常时结束。
每帧最多检查 200 个挂载行，超出会标明截断；输入事件和 Long Task 最多保留 200 和
100 条。停止会释放监听器、observer、计时器和帧回调，开始前和结束后不采样。
报告只保留在当前 renderer 内存，直到被替换或卸载；复制是显式的剪贴板操作。
报告对路由和行身份使用本次采集内的别名，不包含消息正文、会话标题、原始 URL、按键
内容、截图或 DOM HTML，不自动持久化、上传或通过 Hub/MCP 暴露。

## Devframe Hub

启用性能栏时，Desktop 在 `127.0.0.1` 启动一个 Devframe Hub，从 9765 到 9785
选择首个可用端口。Hub 将 `lody-devbar` definition 与官方 Inspector、Accessibility
Inspector 组合。React 性能栏通过类型安全 RPC 发送校验后的样本，
发布最多 120 个样本的可重放 stream，并更新共享快照和 JSON-render view。node 端最多
保留 120 个样本和 100 个 Long Tasks，同时在当前进程生命周期保留 Long Task 汇总。

Devbar 运行时，Developer Mode 会显示第二个“Agent 与终端权限”开关。启用后 Hub 会重启，
加入聚合 HTTP MCP endpoint 和官方 Terminals add-on。MCP 此时暴露只读性能查询、共享状态、
Markdown resource、Inspector 工具和 Terminals 工具。浏览器样本写入不会暴露给 Agent。
Terminals 支持交互式本地 shell 和子进程会话；任意 command 请求保持禁用，但 shell 本身仍是
高权限能力。停止 Devbar 会同时移除这两项能力。

在这个单用户 loopback 模式下，Hub 用 gate 保护 RPC transport，而不是弹出 Devframe 浏览器
信任提示。打包后的 `file://` renderer 使用经 IPC 下发的每进程 token 认证；嵌入的 dock
script 从页面读取同一 token。loopback Origin 上的 Hub 页面、开发 renderer Origin，以及不带
Origin header 的本地非浏览器调用方保持受信。`null` 等 opaque Origin——打包页面与其他浏览器
的 sandboxed frame 无法区分——必须携带 token 才能调用，Lody 自有的 `/__lody/*` 路由则直接
拒绝。HTTP host 仍会拒绝其他浏览器 Origin。普通 renderer 入口保留原 CSP。仅 Devbar renderer
入口允许 loopback Hub script、frame、connection，以及官方 UI 使用的 Iconify endpoint。由于
Electron host page 使用 `file://`，Hub iframe dock URL 会发布成完整 loopback URL，而不是根
相对路径。文件管理、code-server、非 loopback 绑定和远程访问均不在范围内，需要独立的
capability 决策与认证方案。

编码 Agent host 应配置一次 stdio `devframe connect` connector，而不是固定 HTTP 端口。
connector 会发现运行实例、补充 loopback Origin header，并代理二级 gate 启用的读取或终端
工具。Lody 中由 Agent 写入的 MCP entry 在受信 UI 或 CLI 审核选择前保持禁用。

Hub 启动失败时主窗口保留普通 renderer，并在 Settings 中显示错误。嵌入客户端后续断开时
不会停止本地采样，因此 footer 可以在不丢失 node 端有界历史的情况下重连。官方 Hub UI
和内置插件资源以锁定版本的 package assets 随应用提供，可嵌入也可独立打开。可移植静态
快照仍需 build adapter；live Terminals 不能进入静态构建。CPU profile 捕获仍属于独立的
高权限阶段。

## 证据

- [Renderer](../apps/electron/src/renderer/src/devbar/index.tsx)
- [Devframe definition](../apps/electron/src/main/services/devbar/devframe.ts)
- [Main service](../apps/electron/src/main/services/devbar/service.ts)
- [共享诊断契约](../packages/shared/src/devbar.ts)
- [确定性测试](../apps/electron/src/devbar.test.mjs)
- [Devframe bridge 决策](../.agents/notes/implemented/architecture/2026-09-16-devbar-devframe-bridge.zh.md)
- [Devframe Hub UI 决策](../.agents/notes/implemented/feature/2026-09-16-devbar-hub-ui.zh.md)
- [Electron metrics](https://www.electronjs.org/docs/latest/api/structures/process-metric)
- [CLS 定义](https://web.dev/articles/cls)
