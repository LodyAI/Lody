# Lody Plugin System 架构设计

Status: draft
Translation: current

[English](plugin-system.md)

Lody 插件系统将功能由官方预先定义好的 Agent Client，演进为可由 Lody 团队、用户以及运行在 Lody 内的 Coding Agent 共同持续塑形的 Agent Workspace。同一个插件包通过同一套公开 SDK（`shared` + 可选 `client` + 可选 `machine`）同时扩展 Agent 的工具能力、Session 内的交互结果界面、外部系统上下文注入，以及项目或工作区视图，并原生横跨 **`local`（本地桌面）**、**`web`（浏览器客户端）** 与 **`headless`（无界面守护进程）** 三种运行形态——官方新功能与外部插件共用同一套扩展原语。

本文规定横跨 `local`、`web` 与 `headless` 的宿主架构及公开 SDK 契约。

## 场景

用户在本地桌面或连接远程 `headless` 开发机的 `web` 端让 Agent 现场编写测试分诊插件，或安装议题追踪集成与 Git Worktree 管理器：

1. Agent 在本机或远程 `headless` 机器上运行测试套件后，无论用户在 `local` 桌面还是 `web` 浏览器打开该 Session，工具卡片内都直接渲染可筛选的通过/失败表格；勾选失败用例即可将结构化复现摘要追加进当前 Composer 草稿，全程无需再次调用模型。
2. 在 Composer 中输入 `@` 或点击添加附件，客户端通过目标机器 `PluginHost` 持有的凭据搜索外部 Issue，将当前时刻的 Markdown 快照注入本轮输入；同时 Session 右侧伴随面板列出当前项目的关联 Issue，支持在 `headless` 机器上一键创建 24/7 值守、「首次 CI 失败时自动唤醒」的等待态审查 Session，并在换用 `web` 打开或进程重启后按业务意图键自动关联回已接受的 Session。
3. 打开项目的 Worktrees 页面，直接读取目标机器仓库拥有者的活跃 Session Worktree 列表，并打开或请求归档对应的根 Session。

所有 UI 业务操作直接按能力引用携带的 `machineId` 路由至类型化的机器侧处理函数，无需伪造 Agent Turn。

## 稳定内核与可塑表面

为了让 Lody 能够通过插件高速演进，同时守住产品一致性与安全底线，职责严格划分为「不可替换的宿主内核」与「可增强/可接管的表面」：

| 层次     | 归属                   | 范围与不变量                                                                                                                                                                                                           |
| -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主内核 | Lody 核心独占          | Session 历史写入（`HistoryWriter`）、执行准入、交互式权限确认框、即时 Stop 制动、机器身份、密钥存储、E2EE 加密边界，以及带崩溃回退逃生舱的顶层导航壳。插件不能伪造用户发言、替用户批准权限、吞掉 Stop 或改写已存历史。 |
| 可塑表面 | 内置插件与外部插件共用 | Session 内工具调用与结果卡片正文、Composer 附件来源与工具栏动作、Session 右侧伴随面板（Side Panel）、左侧栏组织视图，以及独立的项目、工作区和设置页面。                                                                |

每一处可塑表面均由宿主持有安全外框：

- **工具与结果卡片**由宿主保留状态、耗时、权限控件、原始 JSON 切换开关、Loro 历史载荷上限（[`tool-call-history.ts`](../packages/shared/src/acp/tool-call-history.ts)）及局部 `ErrorBoundary`；挂载历史输出前先执行 `safeParse`，插件未获当前客户端信任、Schema 不兼容或渲染失败时自动回退至内置原始视图。
- **左侧栏组织视图**（`lody.sidebar.views.add`）仅替换会话列表组织区，始终保留新建会话、搜索、定时任务与视图切换菜单可达；插件停用或报错时立即恢复内置列表。
- **独立页面**（`/w/:w/m/:m/projects/:p/plugins/:pkg/:id` 及对应工作区/设置路由）将插件定位状态编码为独立的 `p.<key>` 查询参数，支持刷新与前进后退恢复，但 URL 参数本身不授予任何数据访问权限。

## 一套契约，三种运行形态（Local · Web · Headless）

参照 Paseo 的 `shared / server / client` 切分并与 Lody 的平台装配契约（[`AGENTS.md`](../AGENTS.md#repository-boundary)、[`packages/platform/AGENTS.md`](../packages/platform/AGENTS.md#composition-and-capabilities)）对齐，核心宿主置于平台中立包中：机器侧 `PluginHost` 位于 `apps/cli` daemon，界面侧 `ClientPluginHost` 位于 `@lody/components`，二者通过传输无关的 `MachineRpc`（本机 IPC `LocalMachineRpc` 或远程/E2EE [`WorkspaceMachineRpcFacade`](../packages/components/src/providers/workspace-machine-rpc-facade.ts)，由 `MACHINE_PROTOCOL_CAPABILITIES` 协商能力）衔接。插件安装归属始终锚定在机器维度 `(workspace, machine, pluginId)`，且同时支持全栈插件（`client` + `machine`）、纯 `headless` 机器插件（仅 `machine` / `skills` / `mcpServers` / `acpProviders`）与纯前端视图插件（仅 `client` + `hostQueries`）：

| 组件                                  | 职责                                                                                                                                                                                                                      | 执行模型与故障边界                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lody/plugin-sdk`                    | 定义跨端共享描述子（`defineTool`、`defineQuery`、`defineMutation`、`defineAttachmentSource`、`defineObservation`）、宿主只读目录 `hostQueries`、携带 `machineId` 的能力引用（`WorkspaceRef`、`ProjectRef`、`SessionRef`） | 纯类型契约与宿主运行时映射，不导入任何宿主内部实现；`machine` 与 `client` 无跨端类型依赖。                                                                                                                                                                                             |
| `apps/cli` `PluginHost`               | 管理机器安装记录 `(workspace, machine, pluginId)`、内容摘要 `revision`（SHA-256）、密钥 `env`、私有目录 `dataDir`、内置插件 MCP 路由、宿主目录查询适配，以及按 `revision` 静态托管预编译 `client.js` 与 `assets/`。       | 所有已启用的 `machine` 模块共享同一个 `PluginWorker`。协作式异步慢请求与抛出异常限于单次请求（`AbortSignal`）；同步死循环、原生阻塞或内存溢出以**整个 `PluginWorker`** 为故障边界，由宿主看门狗直接终止并重启 Worker、重新激活插件（连续崩溃时熔断退避），不为每个插件常驻独立子进程。 |
| `@lody/components` `ClientPluginHost` | 在桌面窗口或浏览器标签页按 `(machineId, pluginId, revision)` 评估已信任的纯浏览器 ESM `client.js`，注入宿主 `react`、`react/jsx-runtime`、`@lody/ui`、`@lody/plugin-sdk` 与 `zod`（Zod 4），并按目标 `machineId` 路由调用 | 渲染上下文内 React 执行；每次激活绑定当前构建 `revision`，版本变更或撤销信任时自动中止旧版订阅并释放可选清理回调。                                                                                                                                                                     |

三种运行形态复用同一套包产物，无需为不同端分叉插件代码：

| 运行形态   | 活跃宿主组件                           | 安装、传输与缓存模型                                                                                                                                                         | 信任边界与离线退化行为                                                                                                                                                                                                                                |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`    | `ClientPluginHost` + 本机 `PluginHost` | OSS 桌面端通过本机 `LocalMachineRpc` IPC 直连内嵌/本机 CLI daemon，零云服务依赖；启用 `remoteMachines` 时亦可同时挂载同一工作区内远程 `headless` 机器上的插件。              | 本机用户自行启用的本机插件直接受信；挂载共享/远程机器插件时沿用与 `web` 相同的按客户端 `(pluginId, revision)` 信任门控。                                                                                                                              |
| `headless` | 仅 `apps/cli` `PluginHost`（零窗口）   | 运行于服务器、容器或远程开发机（`lody start`），通过 `lody plugin` CLI 管理；持续承载 Agent 工具、24/7 `defineObservation` 与 `waiting` Session，并向连接客户端提供 bundle。 | 拥有该机器 daemon 所在 OS 用户权限，`ctx.env` 与 `ctx.dataDir` 永不离开该机器；即使没有任何 `local` / `web` 客户端在线，Agent 工具与自动化观察仍独立运行。                                                                                            |
| `web`      | 仅浏览器 `ClientPluginHost`（无守护）  | 经已认证 `MachineRpc`（E2EE 工作区全程走设备认证密文帧 [`e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts)）按需拉取 `client.js`，校验 SHA-256 后缓存于 IndexedDB。          | 远端机器目录记录绝不在浏览器源内自动执行代码：首次加载 `(pluginId, revision)` 须经当前用户在本客户端显式确认信任（未信任时降级为内置原始 JSON 卡片，不影响远端 Agent 工具执行）；缓存命中后离线仍可渲染历史卡片，实时读写诚实返回 `machine_offline`。 |

### 纯浏览器前端约束、Revision 三重职责与分发

为了保证在 `local` 编写的插件无需修改即可在 `web` 与 `headless` 协同工作，构建与同步遵循三条硬约束：

- **`client.js` 纯浏览器可移植边界：** `client` 入口固定以 `platform: 'browser'` 打包为标准 ESM（仅外部化 `react`、`react/jsx-runtime`、`@lody/plugin-sdk`、`@lody/ui` 与 `zod`），编译期禁止导入 Node 内置模块、Electron preload 专属全局对象、本机 `file://` 路径及 `machine` 模块；一切本机文件、Git、SQLite 或外部凭据访问必须经 `defineQuery` / `defineMutation` / `defineAttachmentSource` 走 `MachineRpc` 落到目标 `machineId` 执行。
- **单一内容摘要 `revision`（SHA-256）身兼三职：** 每次编译或打包对 `lody.plugin.json`、`client` 与 `machine` 产物计算确定性内容哈希 `revision`：
  1. _热替换语义门控：_ 客户端每次调用自动携带 `(pluginId, revision)`，`PluginHost` 在执行前校验 `revision === activeRevision`。由于 Schema 兼容不等于行为语义兼容，旧版 UI 在热替换窗口发出的滞后请求直接以 `revision_mismatch` 拒绝（变更绝不自动重放）；而 Worker 重启或网络重连只要代码未变，`revision` 不变，已打开的 `local` / `web` 界面无需重挂载。
  2. _跨端不可变缓存键：_ `web` 与远程 `local` 客户端以 `(machineId, pluginId, revision)` 将 `client.js` 不可变缓存于 IndexedDB，连接同一版本的多个标签页或重连后零重复传输。
  3. _远端代码信任锚点：_ `web` 与共享机器上的客户端信任记录精确绑定到 `(pluginId, revision)` 哈希；远端插件升级代码产生新 `revision` 时（内置插件除外）必须重新确认信任，杜绝远端静默篡改浏览器端执行逻辑。
- **开发态（`lody plugin install --dev <dir>`）与分发态（`lody plugin pack`）：** 开发态由所在机器 daemon 内置 `esbuild` 内存编译，编译失败保留上一可用 `revision`，编译成功先在有界宽限期内执行旧版清理回调（如关闭 `ctx.dataDir` SQLite 句柄），阻塞超时则直接回收并重建 `PluginWorker` 防止新旧代码并发写同一 `dataDir`（[`failure-containment.md`](../.agents/docs/failure-containment.md)），再向连接的 `local` / `web` 客户端广播新 `revision`。分发态产出离线归档（含预编译 `client.js` / `machine.js`、`assets/` 与可选 `skills/<name>/SKILL.md`），在 `local` 或 `headless` 导入时零源码编译、不执行安装脚本、不发起联网下载；加密工作区下远端客户端拉取 bundle 与调用插件全程封装于设备认证 E2EE `MachineRpc` 内（[`packages/platform/AGENTS.md`](../packages/platform/AGENTS.md#e2ee-workspace-control)），云端中继不可见明文插件代码或业务载荷。

### 分平面的生效状态透视

由于运行中的 Agent Turn 绝不热插拔新的 MCP 配置（[`apps/cli/src/mcp/AGENTS.md`](../apps/cli/src/mcp/AGENTS.md)），`lody plugin status` 与管理界面按平面分别报告真实生效范围，而非仅显示笼统的「已加载」：

- **UI 表面：** 在本机窗口及已信任新 `revision` 的 `web` 客户端立即切换生效（待确认信任的远端客户端明确标记为 `trust_pending`）。
- **MCP 工具（`defineTool` 及随包 `mcpServers`）：** 已写入该机器目录；新建 Session 立即可用，已打开 Session 勾选后于下一 Turn 生效。
- **ACP Provider（`acpProviders`）：** 在该机器新建对应 Provider 的 Session 时生效；引用官方 managed runtime 时继续沿用既有校验和验证通道（[`packages/platform/AGENTS.md`](../packages/platform/AGENTS.md#managed-runtime-channel)）。

## 五个正交原语

1. **合一工具声明（`defineTool`）：** 在共享模块中一次性声明工具的 Zod `input` 与 `output`（[`sdk/shared.d.ts`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)）。`machine.tool(tool, execute)` 在目标机器的共享 `PluginWorker` 内运行并自动汇入内置插件 MCP 路由，无需额外启动 stdio 子进程；`lody.tools.render(tool, Component)` 在 `local` 与 `web` 的 Session 历史卡片中将类型化输出渲染为交互组件（[测试报告示例](../scripts/fixtures/plugin-sdk/examples/test-report/client.tsx)）。已有第三方二进制 MCP 仍可通过清单 `mcpServers` 挂载。
2. **Composer 上下文与动作（`defineAttachmentSource` 与 `composer.actions`）：** `machine.attachmentSource` 利用仅存在于目标机器 daemon 的 `ctx.env` 凭据检索外部或机器本地数据，并将结构化 Markdown 快照注入当前草稿（[Issue 上下文示例](../scripts/fixtures/plugin-sdk/examples/issue-context/machine.ts)）。
3. **类型化读写与宿主目录（`defineQuery`、`defineMutation`、`hostQueries`）：** 查询按 `target.machineId` 路由，统一返回四态 `QueryResult<T>`（`loading | ready | unavailable | error`），保留诚实的三态机器/数据源可达性（`machine_offline | unknown | forbidden`），无需插件作者手写多源时间戳传染逻辑。变更处理函数在持久化写入后调用 `ctx.invalidate(query, target?)` 触发连接的 `local` / `web` 活动订阅重读。内置 `hostQueries` 位于共享契约层，`client` 与 `machine` 均可按授权读取现有拥有者的受限投影（`session_list`、[`worktree-observations.ts`](../apps/cli/src/session/worktree/worktree-observations.ts) 与 PR poller）——见纯前端 [Worktrees 示例](../scripts/fixtures/plugin-sdk/examples/worktrees/client.tsx)与 [Focus 侧栏示例](../scripts/fixtures/plugin-sdk/examples/focus-sidebar/client.tsx)。
4. **插件命名空间幂等 Session 创建与目录找回（`sessions.create` 与 `hostQueries.sessions`）：** 宿主会话创建按 `(workspace, user, project, pluginId, idempotencyKey)` 去重，其中 `pluginId` 由宿主从已认证调用上下文注入，插件无法伪造其他插件命名空间；同键同规范化请求返回原 `SessionRef`，同键异参以 `idempotency_conflict` 拒绝。接受请求与写入 Session 目录元数据（`createdByPluginId`、`idempotencyKey`）共享同一原子提交边界：`hostQueries.sessions` 支持 `createdByPlugin`、`idempotencyKey` 与可选 `machineId` 筛选，且仅向创建该会话的同一 `pluginId` 暴露 `SessionSummary.idempotencyKey`。即使 `machine` 在宿主接受 Session 后、写入私有 `ctx.dataDir` SQLite 前崩溃，或用户换用无本地状态的 `web` 端打开项目，都可直接从 `hostQueries.sessions` 找回已接受的 Session（[Issue 面板恢复示例](../scripts/fixtures/plugin-sdk/examples/issue-context/client.tsx)），无需恢复独立的 `plugin.operations` 账本。
5. **Automation 衔接（`defineObservation` 与等待态 Session）：** 插件仅通过 `defineObservation` 向所在机器的 [`automations`](../apps/cli/src/automations/README.md) 贡献只读观察源（`ctx.read('plugin.<pluginId>.<id>', input)`）。这使 `headless` 机器天然承担 24/7 后台值守，且触发绝不脱离 Session 投递任意插件副作用：对于「尚无活跃 Agent，需等待首次 CI 失败再启动审查」的场景，通过 `sessions.create(project, { waitCondition })` 当场创建可见的 `waiting` 态目标 Session（零 Token 消耗）并绑定标准 CodeMode 条件，完整复用现有的 Stop、Cancel 与加密工作区签名准入。

首版明确不包含跨插件 UI 插槽协商（`defineSlot`）；所有插件统一向宿主扩展点注册。

## 面向 AI 的插件自举与无模型验证

为了让运行在 `local` 桌面或远程 `headless` 服务器上的 Coding Agent 都能闭环编写并验证全栈插件：

1. **同源生成的内置开发 Skill：** 宿主随附 `lody-plugin-dev` Skill，其 API 参考直接从当前版本 SDK `.d.ts` 构建生成，确保 Coding Agent 永远基于最新契约编写插件。
2. **可自检的 CLI 闭环：** `lody plugin init` 生成单目录最小工程（`lody.plugin.json` + 入口文件）；`lody plugin check` 一次性执行 TypeScript 类型检查、浏览器/机器双端打包边界检查与清单校验，输出紧凑行列号诊断供 Agent 自动修复。
3. **兼容 Headless 的无模型 Fixture 预览：** `lody plugin preview <dir> --fixture <json> [--headless]` 直接执行 `machine.tool` 并在真实 Session 结果卡片容器与 `@lody/ui` 主题中验证 `client` 组件——桌面端可打开实时预览面，无显示服务器的 `headless` 环境则通过无头渲染冒烟校验组件挂载与 Schema 往返，全程无需大模型或 API Key。

## 保证

- 能力引用（`WorkspaceRef`、`ProjectRef`、`SessionRef`）均由宿主签发并携带确切 `machineId`，在每次 `useQuery`、`useMutation` 与 `useHost` 操作时重新核验权限；纯字符串 ID 与 URL 参数本身不授予任何访问权，目标机器离线时诚实返回 `machine_offline`，绝不静默漂移至其他机器执行。
- `ctx.env` 中的敏感配置与 `ctx.dataDir` 仅保存在所属机器 daemon 中，绝不序列化进 `client.js`、工具回执或错误消息；E2EE 工作区下的远端 bundle 分发与插件 RPC 全程受端到端密文保护。
- **按客户端锁定的远端代码信任：** `web` 及跨机器连接绝不因远端目录存在某插件就在本地浏览器/渲染进程自动执行其 `client.js`；未经当前客户端对精确 `(pluginId, revision)` 显式授权前，界面安全回退内置原始视图。
- **诚实的故障边界与回收语义：** 渲染端异常由局部 `ErrorBoundary` 隔离并回退内置视图；机器端协作式异步慢请求与抛出异常限于单次请求，而同步死循环、进程崩溃或重载清理超时以该机器上**整个共享 `PluginWorker`** 为故障边界——会中断该 Worker 内其他插件的在途 `machine` 调用（变更请求返回 `worker_restarted` 且绝不自动重放，活动查询在新 Worker 就绪后重订阅），但绝不阻塞 daemon 主循环、窗口关闭、Session 即时 Stop 或 `HistoryWriter`，也不会留下永久锁死后续重载的全局门禁。
- **跨热替换与跨端的语义安全：** 所有客户端请求均受构建内容 `revision` 门控；代码热更新后，旧版 `local` 或 `web` UI 组件发出的请求不会因入参 Zod 结构巧合而被新版 handler 错误解释。
- **无裂脑的幂等会话找回：** `(workspace, user, project, pluginId, idempotencyKey)` 的去重接受与 `hostQueries.sessions` 可见性原子一致，跨插件键互不冲突、互不可见。
- 停用或卸载插件立即撤销其 UI 注册及后续 MCP/ACP 选择；已写入的 Session 历史原始记录与正在运行的 Session 仍由原宿主模块管理。

## 待定问题

- 原生 iOS 与 Android 客户端（`apps/mobile`）不运行浏览器/桌面 React `client.js` bundle；移动端是否对部分结构化工具输出提供原生渲染映射有待后续确定。
- E2EE `MachineRpc` 分片帧（[`e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts) 中的 `frames`）承载单个插件 `client.js` 与静态 `assets/` 的精确体积上限，将在实现传输适配层时压测敲定。

## 证据

预期行为：本文档及 [`scripts/fixtures/plugin-sdk/sdk/`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts) 下的公开 SDK 声明（[`client.d.ts`](../scripts/fixtures/plugin-sdk/sdk/client.d.ts)、[`machine.d.ts`](../scripts/fixtures/plugin-sdk/sdk/machine.d.ts)、[`manifest.d.ts`](../scripts/fixtures/plugin-sdk/sdk/manifest.d.ts)）。

已核对实现：[`packages/ui/src/index.ts`](../packages/ui/src/index.ts)、[`packages/components/src/components/ai-gui/view.tsx`](../packages/components/src/components/ai-gui/view.tsx)、[`packages/components/src/providers/workspace-machine-rpc-facade.ts`](../packages/components/src/providers/workspace-machine-rpc-facade.ts)、[`packages/shared/src/e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts)、[`packages/shared/src/acp/tool-call-history.ts`](../packages/shared/src/acp/tool-call-history.ts)、[`packages/platform/AGENTS.md`](../packages/platform/AGENTS.md)、[`apps/cli/src/lib/discovery-query.ts`](../apps/cli/src/lib/discovery-query.ts)、[`apps/cli/src/session/worktree/worktree-observations.ts`](../apps/cli/src/session/worktree/worktree-observations.ts)、[`apps/cli/src/mcp/AGENTS.md`](../apps/cli/src/mcp/AGENTS.md)、[`apps/cli/src/automations/README.md`](../apps/cli/src/automations/README.md)、[`packages/shared/src/automations/reads.ts`](../packages/shared/src/automations/reads.ts) 与 [`.agents/docs/failure-containment.md`](../.agents/docs/failure-containment.md)。

已执行验证：[`scripts/plugin-sdk-contracts.test.mjs`](../scripts/plugin-sdk-contracts.test.mjs) 调用 TypeScript 编译器，针对工作区真实的 `@lody/ui`、React 19 与 Zod 4 完整检查 SDK 类型声明、四个参考插件（[`test-report`](../scripts/fixtures/plugin-sdk/examples/test-report/client.tsx)、[`issue-context`](../scripts/fixtures/plugin-sdk/examples/issue-context/client.tsx)、[`worktrees`](../scripts/fixtures/plugin-sdk/examples/worktrees/client.tsx)、[`focus-sidebar`](../scripts/fixtures/plugin-sdk/examples/focus-sidebar/client.tsx)）及全栈/纯 `headless`/纯 `client` 清单与 `@ts-expect-error` 负向编译边界断言（[`contracts.ts`](../scripts/fixtures/plugin-sdk/contracts.ts)）。`apps/cli` `PluginHost`、`@lody/components` `ClientPluginHost` 与 `lody plugin` CLI 命令尚未实现。
