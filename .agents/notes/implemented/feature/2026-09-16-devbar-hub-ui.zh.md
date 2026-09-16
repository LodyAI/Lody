# Desktop 诊断的官方 Devframe Hub UI

Status: implemented
Translation: current

[English](2026-09-16-devbar-hub-ui.md)

## 摘要

首个 Desktop 接入通过 Devframe 暴露诊断数据，但没有提供 Devframe 完整的参考界面。
Desktop 现在把官方 Hub UI、JSON-render renderer、Inspector、Accessibility Inspector
和 Terminals add-on 组合到同一个 loopback server 和聚合 MCP endpoint 后。该决策在
显式 Devbar runtime gate 下有意加入本地子进程访问；文件管理、code-server 和远程绑定
仍然排除。

## 决策

`@devframes/hub` 负责组合、连接状态、docks、commands、settings、messages、终端聚合和
MCP。`@devframes/hub-ui` 提供未修改的预构建 standalone viewer 与 `embedded.js` 浮动
dock。Lody 性能 definition 注册 JSON-render view 并投影成 `json-render` dock；
`@devframes/json-render-ui` 提供官方 `@antfu/design` renderer。Lody 只保留紧凑性能底栏，
不维护第二套详细 UI。
由于 Devframe 1.0 参考 catalog 没有 chart component，Main Thread 视图会在标准 DataTable
中用 Unicode sparkline 展示最近 60 个 FPS、CPU、heap、RSS 和阻塞时间样本。这样既保留
官方 renderer 边界，也让 dashboard 具备可快速浏览的时间序列视图。

Hub 还挂载 `plugin-inspect`、`plugin-a11y`、`plugin-terminals` 及其发布的 assets package。
Main Thread 是首次激活项。Hub 为无 UI 的 `lody-devbar` definition 自动生成的 iframe
entry 会隐藏，因此用户只会看到可工作的 JSON-render 性能 dock。

Electron 用户页面使用 `file://`，而参考 Hub 通常运行在同源 web host 中。因此 node host
会在发布前把已挂载 iframe entry 改写为完整 loopback URL。只有
`LODY_DEVBAR=true` 时才加载独立 `devbar.html` renderer 入口；该入口允许 loopback
scripts、frames、connections，以及参考 UI 使用的 Iconify endpoint。普通 `index.html`
CSP 不变。

## Capability 边界

Hub 只绑定 `127.0.0.1`，只接受 Lody `file://` 页面，并且仅在开发者显式设置
`LODY_DEVBAR=true` 时存在。该边界内关闭浏览器认证。聚合 MCP endpoint 暴露性能和
Inspector 读取接口以及 Terminals 工具。Terminals 拒绝任意 command 请求，但其交互式
shell 仍提供通用本地进程控制；这是 Devbar 明确要求的子进程能力，不是只读诊断的隐式扩展。

本决策不允许增加 Assets、Code Server、文件系统操作、非 loopback host 或远程访问。
这些变化需要独立的 capability 和认证评审。

## 打包

Hub core 继续打进 Electron CommonJS main 产物。UI 与 plugin package 保持 runtime ESM
import，使其相对于 `import.meta.url` 的预构建 assets 从已安装 package 正确解析。对应的
`--assets` package 会显式声明，以支持打包构建。所有 Devframe package 固定为 1.0.0；
只有这些经过检查的版本绕过仓库 release-age 隔离。

## 验证

Node/Web 类型检查和 Electron 应用构建通过。隔离启动的构建产物从 loopback 提供 Hub
index、embedded bootstrap、JSON renderer 和三个 plugin SPA。MCP initialize 能列出
性能、Inspector、共享状态和 Terminals 工具；共享 dock state 包含完整 loopback iframe
URL，并选中 `lody-main-thread`。静态导出、跨平台打包启动和远程部署未验证。

本决策部分替代早先[桥接决策](../architecture/2026-09-16-devbar-devframe-bridge.zh.md)
中的 UI 与子进程排除项。当前保证由草案状态的
[Desktop 性能栏 Spec](../../../../specs/desktop-devbar.zh.md) 负责。
