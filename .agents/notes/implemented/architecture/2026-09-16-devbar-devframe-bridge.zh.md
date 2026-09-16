# Desktop 诊断的 Devframe 桥接

Status: implemented
Translation: current

[English](2026-09-16-devbar-devframe-bridge.md)

## 摘要

原有 Desktop 性能条能够显示实时计数器，但不能保留短期诊断历史，也不能向编码 Agent 暴露这些数据。现在它以一个 Devframe 定义提供 loopback RPC、共享状态、流式数据和只读 MCP 桥接，同时继续使用已有 React 界面。第一阶段刻意不包含文件系统与子进程控制、独立/静态 UI 资源以及 CPU Profile 归因；这些能力需要另行完成安全和产品决策。

## 问题与职责

既有性能条负责采集渲染器和 Electron 进程指标，并且必须在不启用遥测的前提下继续支持本地打包版本。Devframe 负责可移植的传输和 Agent 投影，不负责指标采集。渲染器采集 FPS、CLS、堆内存、路由和 Chromium Long Task；Electron 主进程补充进程指标、校验样本、限制历史大小并提供 definition。`@lody/shared/devbar` 中的共享 schema 是两个进程之间的契约。

## 决策

仅在 `LODY_DEVBAR=true` 时启动 `lody-devbar`。服务绑定 `127.0.0.1`，从 9765 到 9785 选择第一个可用端口，并使用已有 React footer/overlay 作为浏览器客户端。`record-sample` 更新共享快照和可重放数据流；`get-snapshot` 与一个 Markdown resource 是明确注册的 Agent 接口。样本最多保留 120 个，近期 Long Task 最多保留 100 个，同时在进程生命周期内保留 Long Task 汇总值。Devframe 还会把该共享状态投影为只读 MCP resource/tool。

只有这个单用户 loopback listener 会关闭 Devframe 的浏览器身份验证；MCP 仍保留 loopback Origin gate。该接口只包含诊断数据，没有文件、shell、终端或进程操作。远程 listener 或任何高权限 RPC 必须先恢复身份验证并定义 capability 策略。桥接启动失败不会阻止本地指标和 overlay 使用，只会失去 MCP 与流式数据。编码 Agent host 使用 `devframe connect`，从而发现运行时选择的端口并携带所需的 loopback Origin header。

安装配置对应的 `<protocol>://devbar?view=main-thread` 会打开 overlay。Markdown Agent resource 包含该链接，因此 Agent 可以在报告卡顿后把用户导向同一份有界历史，而不获得操纵应用的权限。

## 打包与依赖策略

Electron 主进程产物是 CommonJS，而 Devframe 1.0 仅提供 ESM。因此 Devframe 会打进主进程 bundle，不会作为运行时 `require()` 的外部依赖；`@devframes/agentic` 仍是明确声明并随应用打包的依赖，由 Devframe optional-peer adapter 加载。1.0.0 发布时仍在仓库七天依赖隔离期内，所以 `minimumReleaseAgeExclude` 只列出两个经过检查的精确版本；后续版本仍受隔离策略约束。

## 备选方案与限制

单独创建 Devframe SPA 会重复已有 footer，并拖慢首个可用接入。若诊断工具需要独立或静态部署，该方案仍然合适，届时 definition 必须增加 client assets 和 build adapter。本次没有引入 terminals add-on：子进程访问是高权限能力，与观察主线程卡顿不是同一个职责。Long Task 也不包含 JavaScript 调用栈，因此 CPU Profile 捕获仍是后续功能。

本决策扩展而非替代原有的
[运行时性能条决策](../feature/2026-09-08-desktop-devbar.zh.md)。当前保证由 draft 状态的 [Desktop 性能条 Spec](../../../../specs/desktop-devbar.md) 负责。
后续的[官方 Hub UI 决策](../feature/2026-09-16-devbar-hub-ui.zh.md)
部分替代了本记录对 UI 与子进程能力的排除。

## 结果与验证

Electron 与 shared package 类型检查通过。七个确定性 Devbar 测试覆盖运行时开关、指标、CLS 窗口、有界 Long Task 历史、汇总记录和深链接选择。包含 Devframe 主进程 bundle 的 Electron 应用构建成功；对构建产物的 smoke 会启动服务、读取 connection metadata，并通过 loopback Origin gate 完成 MCP initialize handshake。本次没有验证跨平台打包启动、广泛的 MCP 客户端互操作或 CPU Profile。
