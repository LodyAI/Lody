# Desktop 诊断的官方 Devframe Hub UI

Status: implemented
Translation: current

[English](2026-09-16-devbar-hub-ui.md)

## 摘要

首个 Desktop 接入通过 Devframe 暴露诊断数据，但没有提供 Devframe 完整的参考界面。
Desktop 现在把官方 Hub UI、JSON-render renderer、Inspector 和 Accessibility Inspector
组合到同一个 loopback server。独立的产品内 capability gate 会加入聚合 MCP 和 Terminals
add-on。文件管理、code-server 和远程绑定仍然排除。

## 决策

`@devframes/hub` 负责组合、连接状态、docks、commands、settings、messages、终端聚合和
MCP。`@devframes/hub-ui` 提供未修改的预构建 standalone viewer 与 `embedded.js` 浮动
dock。Lody 性能 definition 注册 JSON-render view 并投影成 `json-render` dock；
`@devframes/json-render-ui` 提供官方 `@antfu/design` renderer。Lody 只保留紧凑性能底栏，
不维护第二套详细 UI。
由于 Devframe 1.0 参考 catalog 没有 chart component，Main Thread 视图会在标准 DataTable
中用 Unicode sparkline 展示最近 60 个 FPS、CPU、heap、RSS 和阻塞时间样本。这样既保留
官方 renderer 边界，也让 dashboard 具备可快速浏览的时间序列视图。

Hub 始终挂载 `plugin-inspect`、`plugin-a11y` 及其发布的 assets package。只有用户启用
“Agent 与终端权限”后，才挂载 `plugin-terminals` 和聚合 MCP。Main Thread 是首次激活项。
Hub 为无 UI 的 `lody-devbar` definition 自动生成的 iframe entry 会隐藏，因此用户只会
看到可工作的 JSON-render 性能 dock。

Electron 用户页面使用 `file://`，而参考 Hub 通常运行在同源 web host 中。因此 node host
会在发布前把已挂载 iframe entry 改写为完整 loopback URL。隐藏的 Developer Mode 控件
会启动 Hub，并把主窗口重载到独立的 `devbar.html` renderer 入口；该入口允许 loopback
scripts、frames、connections，以及参考 UI 使用的 Iconify endpoint。普通 `index.html`
CSP 不变，辅助窗口也始终使用普通入口。`LODY_DEVBAR=true` 仅保留为自动化覆盖。

## Capability 边界

Hub 只绑定 `127.0.0.1`，只接受 Lody `file://` 页面和自身 loopback Origin，并拒绝其他
浏览器 Origin。该单用户边界内关闭浏览器认证。Devbar 在每次进程启动时默认关闭，只能从
主窗口隐藏的 Developer Mode 控件或自动化覆盖启动。

默认 Hub 没有聚合 MCP endpoint 或 Terminals dock。独立的“Agent 与终端权限”开关会重启
Hub，加入性能与 Inspector 的 Agent 接口和 Terminals 工具。Terminals 拒绝任意 command
请求，但其交互式 shell 仍提供通用本地进程控制。停止 Devbar 会关闭 listener 并移除两项能力。

本决策不允许增加 Assets、Code Server、文件系统操作、非 loopback host 或远程访问。
这些变化需要独立的 capability 和认证评审。

## 打包

Hub core 继续打进 Electron CommonJS main 产物。UI 与 plugin package 保持 runtime ESM
import，使其相对于 `import.meta.url` 的预构建 assets 从已安装 package 正确解析。对应的
`--assets` package 会显式声明，以支持打包构建。所有 Devframe package 固定为 1.0.0；
只有这些经过检查的版本绕过仓库 release-age 隔离。

## 验证

Node/Web 类型检查和 Electron 应用构建通过。隔离启动的构建产物从 loopback 提供 Hub
index、embedded bootstrap、JSON renderer 和 plugin SPA。不设置 `LODY_DEVBAR` 的启动测试
验证了关闭 → 无 MCP 的 Hub → 带 MCP 与 Terminals 的 Hub → 关闭。启用二级 capability 后，
MCP initialize 能列出性能、Inspector、共享状态和 Terminals 工具；共享 dock state 包含完整
loopback iframe URL，并选中 `lody-main-thread`。静态导出、跨平台打包启动和远程部署未验证。

本决策部分替代早先[桥接决策](../architecture/2026-09-16-devbar-devframe-bridge.zh.md)
中的 UI 与子进程排除项。当前保证由草案状态的
[Desktop 性能栏 Spec](../../../../specs/desktop-devbar.zh.md) 负责。

## 更正

- 2026-09-16：Main Thread 旁新增 `Trends` iframe dock，由 Hub 同源的 Lody 自有
  loopback 路由（`/__lody/chart`、`/__lody/chart.js`、`/__lody/snapshot.json`）提供。
  页面直接轮询快照路由——不经 devframe client——并用 canvas 绘制折线图。这是对
  “Lody 不维护第二套详细界面”的有限例外：它补上 JSON-render catalog 缺少的
  时间序列展示面，而非并行的视图样式表。
- 2026-09-16：单独的 iframe dock 改为嵌入式：可见的 `Main thread` dock 现在是
  `custom-render` 条目，其 Lody 自有模块（`/__lody/dock-renderer.mjs`）通过客户端
  `renderers` 注册表挂载隐藏的 JSON-render 视图，并在同一 dock 内追加 canvas 趋势卡。
  视图 spec 中的 sparkline `DataTable` 随之移除——真图是它的替代，而非第二份展示。
- 2026-09-16：更正先前“该单用户边界内关闭浏览器认证”的表述。放行 `Origin: null`
  的范围超出了它本要覆盖的打包 `file://` 页面：任意网站的 sandboxed frame 呈现相同的
  opaque Origin，可以借宽松的 `cross-origin` 资源策略访问 Hub 的 HTTP 路由（启用
  agent access 时还包括 MCP 路由）。Hub 现在安装一个 `DevframeAuthHandler`：renderer
  经 IPC 获得每进程 token，通过 `connectDevframe({ authToken })` 出示，并经由
  `__DEVFRAME_CONNECTION_AUTH_TOKEN__` 提供给嵌入的 dock script。Hub 同源页面、开发
  renderer Origin 和不带 Origin header 的非浏览器调用方保持受信，因此独立 viewer 和
  `devframe connect` 行为不变；不带 token 的 opaque Origin 可以建立连接，但 `authorize`
  会拒绝所有非 `anonymous:` 方法。Lody 自有的 `/__lody/*` 路由则直接拒绝 `Origin: null`。
  MCP 维持原有 `authorization: false` + Origin gate 姿态；token 不写入实例注册表或
  agent 可读的状态。
- 2026-09-23：独立的“Agent 与终端权限”gate 已移除；启用中的 Hub 现在始终挂载聚合
  MCP 和 Terminals。见[合并决策](../simplification/2026-09-23-devbar-agent-access-merged.zh.md)。
