# Desktop 诊断的 Devframe 桥接

Status: implemented
Translation: current

[English](2026-09-16-devbar-devframe-bridge.md)

## 摘要

原有 Desktop 性能条能够显示实时计数器，但不能保留短期诊断历史，也不能向编码 Agent 暴露这些数据。现在它以一个 Devframe 定义提供 loopback RPC、共享状态和流式数据，同时继续使用已有 React 界面。Agent 投影只在第二个显式 capability gate 后可用。文件系统控制、独立/静态 UI 资源和 CPU Profile 归因仍需独立的安全与产品决策。

## 问题与职责

既有性能条负责采集渲染器和 Electron 进程指标，并且必须在不启用遥测的前提下继续支持本地打包版本。Devframe 负责可移植的传输和 Agent 投影，不负责指标采集。渲染器采集 FPS、CLS、堆内存、路由和 Chromium Long Task；Electron 主进程补充进程指标、校验样本、限制历史大小并提供 definition。`@lody/shared/devbar` 中的共享 schema 是两个进程之间的契约。

## 决策

`lody-devbar` 随生产应用发布，但在每次进程启动时默认关闭。隐藏的 Developer Mode 控件会按需启动它，并只把主窗口重载到 Devbar 专用 renderer 入口；`LODY_DEVBAR=true` 仅保留为自动化覆盖。服务绑定 `127.0.0.1`，从 9765 到 9785 选择第一个可用端口，并使用已有 React footer/overlay 作为浏览器客户端。`record-sample` 更新共享快照和可重放数据流；样本最多保留 120 个，近期 Long Task 最多保留 100 个，同时在进程生命周期内保留 Long Task 汇总值。

只有这个单用户 loopback listener 会关闭 Devframe 的浏览器身份验证。HTTP host 只接受打包后的 file renderer 和自身 Origin，并拒绝其他浏览器 Origin。默认接口只包含诊断数据，没有 shell、终端或进程操作。Developer Mode 提供第二个开关，用于重启 Hub 并加入聚合 MCP 与受限 Terminals add-on；该高权限边界由后续的[官方 Hub UI 决策](../feature/2026-09-16-devbar-hub-ui.zh.md)负责。远程 listener 必须先恢复身份验证并定义 capability 策略。启动失败时普通 renderer 保持可用。

安装配置对应的 `<protocol>://devbar?view=main-thread` 会打开 overlay。Markdown Agent resource 包含该链接，因此 Agent 可以在报告卡顿后把用户导向同一份有界历史，而不获得操纵应用的权限。

## 打包与依赖策略

Electron 主进程产物是 CommonJS，而 Devframe 1.0 仅提供 ESM。因此 Devframe 会打进主进程 bundle，不会作为运行时 `require()` 的外部依赖；`@devframes/agentic` 仍是明确声明并随应用打包的依赖，由 Devframe optional-peer adapter 加载。1.0.0 发布时仍在仓库七天依赖隔离期内，所以 `minimumReleaseAgeExclude` 只列出两个经过检查的精确版本；后续版本仍受隔离策略约束。

## 备选方案与限制

单独创建 Devframe SPA 会重复已有 footer，并拖慢首个可用接入。若诊断工具需要独立或静态部署，该方案仍然合适，届时 definition 必须增加 client assets 和 build adapter。子进程访问不属于默认诊断能力，必须通过独立运行时开关启用。Long Task 也不包含 JavaScript 调用栈，因此 CPU Profile 捕获仍是后续功能。

本决策扩展而非替代原有的
[运行时性能条决策](../feature/2026-09-08-desktop-devbar.zh.md)。当前保证由 draft 状态的 [Desktop 性能条 Spec](../../../../specs/desktop-devbar.md) 负责。
后续的[官方 Hub UI 决策](../feature/2026-09-16-devbar-hub-ui.zh.md)
部分替代了本记录对 UI 与子进程能力的排除。

## 结果与验证

Electron 与 shared package 类型检查通过。确定性 Devbar 测试覆盖运行时与二级 capability gate、浏览器 Origin 边界、renderer 入口、指标、CLS 窗口、有界 Long Task 历史、汇总记录和深链接选择。包含 Devframe 主进程 bundle 的 Electron 应用构建成功；对构建产物的 smoke 会启动服务、读取 connection metadata，并通过 loopback Origin gate 完成 MCP initialize handshake。本次没有验证跨平台打包启动、广泛的 MCP 客户端互操作或 CPU Profile。

## 附录：故障隔离（2026-09-17）

默认关闭的边界同样适用于启用路径内部的故障。主进程在 uncaughtException 时会退出，
因此 loopback 请求监听器（`createDevbarRequestListener`）把抛异常的路由或 Hub
中间件收敛为 HTTP 500；HTTP server 在 listen 成功后保留常驻 `error` 监听器。关闭
Hub 不再能让禁用或退出路径 reject，渲染端底栏挂载在专用 `ErrorBoundary` 内，崩溃时
渲染为空。Devbar 故障降级为无诊断，而不是拖垮应用。确定性测试覆盖该监听器的
500/503/404/403 分支。
