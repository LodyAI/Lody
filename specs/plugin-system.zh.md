# Lody Plugin System 架构设计

Status: draft
Translation: current

[English](plugin-system.md)

Lody 插件系统将功能由官方预先定义好的 Agent Client，演进为可由 Lody 团队、用户以及运行在 Lody 内的 Coding Agent 共同持续塑形的 Agent Workspace。同一个插件包通过同一套公开 SDK（`shared` + 可选 `client` + 可选 `machine`）同时扩展 Agent 的工具能力、Session 内的交互结果界面、多 Session 编排工作流、外部系统上下文注入，以及项目或工作区视图，并原生横跨 **`local`（本地桌面）**、**`web`（浏览器客户端）** 与 **`headless`（无界面守护进程）** 三种运行形态——官方新功能与外部插件共用同一套扩展原语。

本文规定横跨 `local`、`web` 与 `headless` 的宿主架构、公开 SDK 契约、加密工作区（E2EE）安全边界及分阶段落地路径。详细架构取舍与被否决方案记录于 [插件架构演进收敛与 E2EE 工作区边界](../.agents/notes/proposed/architecture/2026-11-22-plugin-architecture-and-e2ee-boundaries.zh.md)。

## 场景

用户在本地桌面或连接远程 `headless` 开发机的 `web` 端让 Agent 现场编写测试分诊插件，或安装议题追踪集成与 Git Worktree 管理器：

1. Agent 在本机或远程 `headless` 机器上运行测试套件期间，工具卡片立即以 `running` 态挂载并通过作用域查询实时呈现测试进度，全程零 Loro CRDT 历史写放大；执行完成后，无论在 `local` 桌面还是离线重开的 `web` 浏览器查看该 Session，卡片都从有界历史快照直接渲染可筛选的通过/失败表格，支持一键联动打开右侧 Session 详情面板，或勾选失败用例将结构化复现摘要追加进 Composer 草稿，无需再次调用模型。
2. 在 Composer 中输入 `@` 或点击添加附件，客户端通过目标机器 `PluginHost` 持有的凭据搜索外部 Issue，将当前时刻的 Markdown 快照注入本轮输入；同时 Session 右侧伴随面板（即使在未绑定 Project 的普通 Session 中也可按 `SessionRef` 独立查询插件状态）列出关联 Issue，支持在 `headless` 机器上一键创建 24/7 值守、「外部状态就绪时自动唤醒」的等待态 Session，支持按项目级业务键在团队成员间去重同一值守任务，并支持追加指令（`sessions.send`）或请求制动（`sessions.requestStop`）。
3. 打开项目的 Worktrees 页面读取目标机器仓库拥有者的活跃 Session Worktree 列表，或在跨机器的 Focus 侧栏按逻辑 `WorkspaceRef` 汇总多台机器上的活跃 Session。

所有 UI 业务操作按目标能力引用直接调用宿主或对应机器上的类型化处理函数，无需伪造 Agent Turn。

## 稳定内核、可组合编排与可塑表面

遵循「宿主内核握有最终准入与制动权，公开 SDK 开放可组合的宿主行动能力」原则，职责严格划分为不可绕过的宿主内核与可塑表面：

| 层次                 | 归属                   | 范围与不变量                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主内核             | Lody 核心独占          | Session 历史写入（`HistoryWriter`）、Inbox 执行准入与防环限制、交互式权限确认框、即时 Stop 制动、机器身份、密钥存储、E2EE 签名边界，以及带安全模式逃生舱的顶层导航壳。插件不能直接改写底层 Loro 文档、替用户静默批准权限或吞掉 Stop。                               |
| 受控宿主编排 API     | 内核授权、插件可组合调 | 在 `MachineRef` 或 `ProjectRef` 上创建等待/运行态 Session（`sessions.create`）、投递或排队消息（`sessions.send`）、请求标准制动与归档（`requestStop` / `requestArchive`）、联动打开伴随面板（`panels.openSession`），以及读取受限目录与会话详情（`hostQueries`）。  |
| 可塑表面与扩展运行时 | 内置插件与外部插件共用 | Session 工具与结果卡片正文、Composer 附件来源与动作、Session 右侧伴随面板、左侧栏组织视图、项目/工作区/设置页面，以及通过 `acpProviders` 接入的新 Agent Runtime（如 Sorbet，配合 Session 级面板与编排 API 构成完整工作台，绝不在后台脱离 Session 跑隐形自治循环）。 |

每一处可塑表面均由宿主持有安全外框：

- **工具与结果卡片**由宿主保留状态、耗时、权限控件、原始 JSON 切换开关与局部 `ErrorBoundary`；已完成的历史输出挂载前先执行 `safeParse`，插件未获当前客户端信任、Schema 不兼容或渲染抛错时自动回退至内置原始视图。
- **左侧栏组织视图**（`lody.sidebar.views.add`）仅替换会话列表组织区，始终保留新建会话、搜索、定时任务与视图切换菜单可达；若受信前端脚本发生渲染抛错由 `ErrorBoundary` 立即回退，若发生同步主线程卡死则可通过宿主顶层安全模式参数一键禁用插件重开（不影响守护进程侧 `HistoryWriter` 与 CLI/远端 Stop）。
- **独立页面与伴随面板联动**将独立页面定位状态编码为 `p.<key>` URL 查询参数，并通过宿主 `host.panels.openSession(session, panelId, params)`（`SessionPanelProps.params`）传递 Session 伴随面板定位参数，无需借用模块级全局变量，且 URL 参数本身不授予任何数据访问权限。

## 一套契约，三种运行形态（Local · Web · Headless）

参照 Paseo 的 `shared / server / client` 切分并与 Lody 平台装配契约（[`AGENTS.md`](../AGENTS.md#repository-boundary)、[`packages/platform/AGENTS.md`](../packages/platform/AGENTS.md#composition-and-capabilities)）对齐：机器侧 `PluginHost` 位于 `apps/cli` daemon，界面侧 `ClientPluginHost` 位于 `@lody/components`，通过传输无关的 `MachineRpc`（本机 `LocalMachineRpc` IPC 或远程 [`WorkspaceMachineRpcFacade`](../packages/components/src/providers/workspace-machine-rpc-facade.ts)）衔接。

为了在多机器工作区中消除「逻辑数据范围」与「执行机器位置」的混淆，能力引用严格区分两类作用域（[`sdk/shared.d.ts`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)）：

- **逻辑工作区作用域（`WorkspaceRef { workspaceId }`）：** 不绑定单一 `machineId`。`hostQueries.machines`、`hostQueries.projects` 与工作区级 `hostQueries.sessions` 直接读取客户端已同步的工作区目录视图——单台机器离线绝不会拖垮整个工作区侧栏；跨机器工作区页面可通过 `hostQueries.machines` 枚举在线 `MachineRef` 按机器显式扇出查询。
- **机器执行作用域（`MachineRef`、`ProjectRef`、`SessionRef`）：** 均携带确切 `machineId`。插件自定义的 `defineQuery`、`defineMutation` 与 `defineObservation` 统一限定在 `MachinePluginScope`（`'machine' | 'project' | 'session'`），使 `'session'` 成为真正的一等作用域（包括未绑定 Project 的普通 Session）。

| 组件                                  | 职责                                                                                                                                                                                                  | 执行模型与故障边界                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lody/plugin-sdk`                    | 跨端共享描述子、宿主只读目录 `hostQueries`（含 `machines`、`sessionDetail`）、RPC/产物字节上限常量及四级品牌能力引用（`WorkspaceRef`、`MachineRef`、`ProjectRef`、`SessionRef`）。                    | 纯类型契约与宿主运行时映射；编译期强制 `client` 零 Node 依赖、`machine` 零 DOM 依赖且互不跨端导入。                                                                                                                                                                                                                 |
| `apps/cli` `PluginHost`               | 管理机器安装记录 `(workspace, machine, pluginId)`、三摘要（`clientDigest`、`machineDigest` 与全包 `revision`）、密钥 `env`、`dataDir` / `sessionDataDir`、内置插件 MCP 路由，以及预编译前端产物分发。 | 每台机器所有已启用的 `machine` 模块共享**单个 `child_process.fork` 辅助进程**（`PluginWorker`）：隔离原生崩溃/OOM 不波及主 daemon，空闲或多次 HMR 后滚动重建；进程重启时对在途只读 `defineQuery` / `defineObservation` 自动透明重试一次，未归因卡死或 OOM 先经短生命周期金丝雀进程隔离复现再标记 `plugin_faulted`。 |
| `@lody/components` `ClientPluginHost` | 在桌面窗口或浏览器标签页按 `(machineId, pluginId, clientDigest)` 评估已信任的纯浏览器 ESM `client.js`，注入宿主 `react`、`@lody/ui`、`@lody/plugin-sdk` 与 `zod`（Zod 4），按 `machineId` 路由。      | 渲染进程/浏览器主线程内 React 执行；每次激活绑定当前包 `revision`，版本变更或在线收到停用通知时中止旧订阅并执行可选清理回调。                                                                                                                                                                                       |

三种运行形态复用同一套插件产物（同时支持全栈、纯 `headless` 机器插件与纯 `client` 视图插件）：

| 运行形态   | 活跃宿主组件                           | 安装、传输与缓存模型                                                                                                                                                             | 信任边界与离线退化行为                                                                                                                                                                                                                       |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`    | `ClientPluginHost` + 本机 `PluginHost` | OSS 桌面端通过本机 `LocalMachineRpc` IPC 直连内嵌/本机 CLI daemon，零云服务依赖；启用 `remoteMachines` 时亦可挂载同一工作区内远程 `headless` 机器插件。                          | 本机用户启用的本机插件直接受信；挂载共享/远程机器插件时沿用按客户端 `(pluginId, clientDigest)` 信任门控。                                                                                                                                    |
| `headless` | 仅 `apps/cli` `PluginHost`（零窗口）   | 运行于服务器、容器或远程开发机（`lody start`），通过 `lody plugin` CLI 管理；持续承载 Agent 工具、24/7 `defineObservation` 与 `waiting` Session。                                | 拥有该机器 daemon 所在 OS 用户权限，`ctx.env`、`ctx.dataDir` 与 `ctx.sessionDataDir` 永不离开该机器；即使无任何 `local` / `web` 客户端在线，Agent 工具与自动化观察仍独立运行。                                                               |
| `web`      | 仅浏览器 `ClientPluginHost`（无守护）  | 经专用受控 `MachineRpc` 插件方法拉取预编译 `client.js` 与 `assets/`（打包前端产物总上限 `MAX_PACKED_CLIENT_BUNDLE_BYTES` = 4 MiB），校验 `clientDigest` 后按工作区安全规则缓存。 | 远端目录记录绝不在浏览器内自动执行 JS：正式包按 `(pluginId, clientDigest)` 显式确认信任，开发态（`--dev`）授予有期限的 `(machineId, pluginId)` 开发会话租约避免每次 HMR 重复弹窗；在线停用即时撤销，离线期间允许已缓存卡片只读渲染历史输出。 |

### 纯浏览器前端约束、三哈希职责切分与在途 Turn 规则

1. **`client.js` 纯浏览器可移植边界：** `client` 固定以 `platform: 'browser'` 编译为标准 ESM（仅外部化 `react`、`react/jsx-runtime`、`@lody/plugin-sdk`、`@lody/ui` 与 `zod`），编译期禁止导入 Node 内置模块、Electron preload 专属对象、`file://` 路径与 `machine` 模块。
2. **三内容哈希精确解耦「前端信任缓存」、「在途 Turn 工具稳定」与「跨端 RPC 一致性」（零人工维护）：**
   - **`clientDigest` = `SHA-256(client.js + assets/)`：** 专管客户端 bundle 缓存键与远端前端代码信任确认。仅修改 `machine.ts`、`skills/` 或版本号时 `clientDigest` 不变，`web` 客户端无需重下 bundle，更不会重复弹出信任确认框。
   - **`machineDigest` = `SHA-256(manifest.machine + machine.js + toolSchemas)`：** 专管 `PluginWorker` 后端身份与在途 Agent Turn 冻结。正在运行的 Agent Turn 在启动时冻结当时的 `(pluginId, machineDigest)`：Turn 运行期间修改 `client.tsx`、`assets/` 或 `skills/` 绝不会中断在途工具调用；唯有 `machineDigest` 实质变更时，该 Turn 后续调用该插件工具才明确返回版本变更错误，绝不在同一 `ctx.dataDir` 上双开新旧两版 handler，新工具定义于下一 Turn 生效。
   - **`revision` = `SHA-256(lody.plugin.json + client + machine + assets + skills)`：** 完整分发产物身份，专管跨端 `client ↔ machine` RPC 语义一致性。客户端 `plugin/query` 与 `plugin/mutate` 携带 `(pluginId, revision)`，滞后旧 UI 请求以 `revision_mismatch` 拒绝。
3. **开发态（`--dev`）、分发态（`pack`）与 Agent 提案门禁（`propose`）：** `--dev` 由机器 daemon 内置 `esbuild` 内存编译，切换前在宽限期内执行旧版清理回调，超时则直接回收共享 `PluginWorker` 子进程（插件自行 `spawn` 的外部进程须绑定父进程退出清理）。`lody plugin pack` 产出离线归档（前端产物上限 `MAX_PACKED_CLIENT_BUNDLE_BYTES` = 4 MiB），导入时零源码编译、零安装脚本、零联网下载。Lody 内的 Coding Agent 现场编写插件后通过 `lody plugin propose <dir>` 发起提案，在会话流中渲染须经人类显式确认的启用卡片（对齐 `AgentRoleProposalNotice`），严禁 Agent 静默自启可执行插件。

## 五个正交原语与历史存储契约

1. **合一工具声明、运行态实时渲染与有界历史载荷（`defineTool` 与 `results.add`）：** 在共享模块中一次性声明工具的 Zod `input` 与 `output`（[`sdk/shared.d.ts`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)）。工具开始执行时卡片立即以运行态挂载（`status: 'running'`、`toolCallId`、`output: undefined`），长耗时工具可将中间进度写入 `ctx.sessionDataDir` 并通过 `useQuery` + `ctx.invalidate` 实时刷新界面，全程零 Loro CRDT 写放大（[测试报告示例](../scripts/fixtures/plugin-sdk/examples/test-report/client.tsx)）。完成时，由于现有 [`history-apply.ts`](../packages/shared/src/acp/history-apply.ts) 会剥离普通 ACP 工具无界的 `rawOutput`，内置插件 MCP 路由将通过 `output` Schema 校验的最终结果写入专用的有界 `tool_call` 插件字段（`{ pluginId, toolId, producerRevision, output }`），硬上限为 **`MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES`（16 KiB UTF-8）**。超过 16 KiB 的详情由插件写入宿主托管的按会话目录 **`ctx.sessionDataDir`**（随 Session 删除自动回收，并在 `session/fork` 分叉时相互隔离）或安装级 `ctx.dataDir`，通过 `defineQuery` 按需拉取。独立于 `defineTool`，`lody.results.add(mimeType, ...)` 支持任意 ACP/外部 MCP 工具产出的 ≤16 KiB 结构化资源块自定义卡片渲染。
2. **Composer 上下文与动作（`defineAttachmentSource` 与 `composer.actions`）：** `machine.attachmentSource` 利用目标机器 daemon 独有的 `ctx.env` 凭据检索外部或本机数据，并将结构化 Markdown 快照注入当前草稿（[Issue 上下文示例](../scripts/fixtures/plugin-sdk/examples/issue-context/machine.ts)）。
3. **分作用域读写与宿主目录（`defineQuery`、`defineMutation`、`hostQueries`）：** 插件读写限定于 `'machine' | 'project' | 'session'` 作用域，单次请求载荷上限 **`MAX_PLUGIN_RPC_REQUEST_BYTES`（256 KiB UTF-8）**，统一返回四态 `QueryResult<T>`（`loading | ready | unavailable | error`）并保留三态可达性（`machine_offline | unknown | forbidden`）。共享 `hostQueries` 向 `client` 与 `machine` 暴露现有拥有者的受限只读投影：`machines`、`projects`、`sessions`、`sessionDetail`、`worktrees`（[`worktree-observations.ts`](../apps/cli/src/session/worktree/worktree-observations.ts)）与 `pullRequests`——见 [Worktrees 示例](../scripts/fixtures/plugin-sdk/examples/worktrees/client.tsx)与跨机器 [Focus 侧栏示例](../scripts/fixtures/plugin-sdk/examples/focus-sidebar/client.tsx)。
4. **Session 编排、请求幂等性与分级业务键（`sessions.create` / `send` / `requestStop`）：** `sessions.create` 与 `drafts.open` 支持 `ProjectRef` 或 `MachineRef`（用于未绑定 Project 的普通 Session）。`sessions.create` 用必填 `requestId`（固定按 `(workspace, user, target, pluginId)` 隔离）标识单次请求，用可选 `businessKey` 配合 `businessKeyScope: 'user' | 'project'`（默认 `'user'`；`'project'` 要求 `ProjectRef` 并按 `(workspace, project, pluginId)` 隔离，使团队协作者共享同一个活跃 Issue/PR 值守任务）标识业务任务。宿主先检查持久请求回执：同一 `requestId`、同一规范化输入始终返回原 `SessionRef`，即使原 Session 已归档；同 ID 异参返回 `idempotency_conflict`。只有新请求才检查业务键：已有未归档 Session 时返回 `business_key_conflict`，归档后允许用**新的 `requestId`** 创建下一代任务（[Issue 面板示例](../scripts/fixtures/plugin-sdk/examples/issue-context/client.tsx)）。`sessions.send` 按 `(session, pluginId, idempotencyKey)` 经既有 Session Inbox 准入与防环上限（[`apps/cli/src/mcp/AGENTS.md`](../apps/cli/src/mcp/AGENTS.md)）投递，`sessions.requestStop` 委托宿主即时制动。
5. **Automation 衔接（`defineObservation` 与参数化等待态 Session）：** 插件向所在机器 [`automations`](../apps/cli/src/automations/README.md) 注册返回 `{ value, revision? }` 的只读观察源（`ctx.read('plugin.<pluginId>.<id>', input)`），并可在 mutation 或本地 webhook 中调用 `ctx.invalidate(observation, ...)` 触发即时重轮询唤醒提示。`CreateSessionRequest.waitCondition` 通过 `waitCondition.params`（`CodeMode` 内 `ctx.params`）传递结构化参数以杜绝 JS 源码字符串拼接，且固定在**只读 `CodeMode`**（禁用 `ctx.exec`）中执行。`PluginWorker` 瞬时重启（`worker_restarted` / `unavailable`）不计入 Automation 连续 5 次永久 `failed` 计数；当观察源返回 `revision` 时，Session 唤醒准入会在派发 Turn 前二次核验该版本证据。

宿主在派发任何 Agent 工作之前，原子接受请求回执、业务键占用与 Session 目录身份；请求恢复先于当前业务键检查，不能将旧请求改投同键的新一代 Session。插件在发送前保留 `requestId` 与完整输入，未知结果重试不得重新生成 ID。归档或删除 Session 不删除请求身份；已删除对象的回执只能返回原引用或明确的已删除结果，不能重建。目录中的业务键仅向同一插件来源公开，每次重放仍重新检查当前访问权限。

首版明确不包含跨插件 UI 插槽协商（`defineSlot`）；所有插件统一向宿主扩展点注册。

## 加密工作区（E2EE）插件契约

在端到端加密工作区（[`specs/e2ee-foundations.zh.md`](e2ee-foundations.zh.md)）中，插件系统在不改动底层账本与密文帧格式的前提下严格服从九项加密边界：

| 边界维度                       | E2EE 插件强制规则                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 访客（`read`）与写者 RPC 切分  | 因「方法名不能证明 `PluginWorker` 代码只读」（[`e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts)），仅宿主静态托管的 `plugin/catalog` 与 `plugin/bundle-chunk` 进入 `E2EE_READ_QUERY_METHODS`，供 `read` 访客校验 `clientDigest` 并只读渲染 ≤16 KiB 历史内联卡片；`plugin/query`、`plugin/mutate` 与 `plugin/attachment-*` 一律走非访客 `authorizeExecution`（要求 `<15 分钟` 内存账本新鲜度）。                                |
| 机器拥有者与按项目机器共享     | E2EE 机器默认私有并按项目显式共享（[`specs/e2ee/machine-sharing.zh.md`](e2ee/machine-sharing.zh.md)）。`'machine'` 级调用、插件安装/启停及 `binding: 'installation'` 设置严格限定**机器拥有者本人**；项目协作者仅当 `MachineSharing` 当前同时共享该机器及目标绑定的全部项目时，方可调用 `'project'` 与 `'session'` 级插件读写。                                                                                                  |
| 签名执行意图与 20 次派生配额   | 前端 `useHost().sessions.create` / `send` 在个人设备上就地签发 `memberInput`（`kind = 1`，[`e2ee-execution-intent.ts`](../packages/shared/src/e2ee-execution-intent.ts)）。机器侧 `ToolExecutionContext` 签发携带 `derivedFrom`（锚定已验签人工根 Turn）的 `machineInput`（`kind = 2`），受共享成员 20 次派生上限与禁止跨机器派生约束；无根 Turn 的 `MachineContext` 调用 `create` / `send` 直接拒绝（`forbidden`）。            |
| Iroh 单帧快路径与分片拉取产物  | `MAX_PLUGIN_RPC_REQUEST_BYTES`（256 KiB）确保桌面端 `plugin/query` 与 `plugin/mutate` 装入单个 1 MiB `purpose 8` 帧直走 Desktop↔Machine Iroh P2P 低延迟通道；浏览器 `web` 走加密 Streams RPC。`plugin/bundle-chunk` 直接复用既有 256 KiB `purpose 9` 响应分页（`MAX_PACKED_CLIENT_BUNDLE_BYTES` = 4 MiB ≤ 16 MiB 分页上限），零协议层改动。                                                                                      |
| 双端密钥保管隔离与撤销终态擦除 | E2EE 前端插件产物与信任记录严禁落入全局明文 IndexedDB：持久化缓存须包裹在 `<account>/<workspace>/<genesis>/<signing-key>` 保管域下（[`client-custody.zh.md`](e2ee/client-custody.zh.md)、[`desktop-custody.zh.md`](e2ee/desktop-custody.zh.md)），工作区模式 `unknown` 期间冻结挂载，并在确切确认 `e2ee_member_removed` / `e2ee_device_revoked` 时随托管内容一并擦除；守护进程 `dataDir` / `sessionDataDir` 隔离于对应身份目录。 |
| 遥测脱敏、静态分享与凭据外发   | Presence 白名单与遥测剥离全部插件 ID、工具名与异常堆栈。显式同意的明文静态 Session 分享仅导出历史内联 ≤16 KiB 结果（绝不上传 daemon `sessionDataDir`），匿名访问者固定使用宿主内置结构化回退视图而不执行第三方 `client.js`。E2EE 插件零云端托管 GitHub/Broker 令牌注入；启用含 `env`、`attachmentSource`、`mcpServers` 或 `acpProviders` 的插件时显式提示本机网络外发边界。                                                      |

## 面向 AI 的插件自举与分阶段交付路线

1. **同源 Skill、双端边界自检与受控提案流：** 内置 `lody-plugin-dev` Skill 直接从当前 SDK `.d.ts` 生成 API 参考；`lody plugin init` 生成最小工程；`lody plugin check` 同时校验浏览器端（零 Node 依赖）与机器端（零 DOM 依赖）打包及清单诊断；`lody plugin preview <dir> --fixture <json> [--headless]` 支持桌面实时预览与 `headless` 无头冒烟校验；`lody plugin propose <dir>` 将 Agent 生成的插件提交至会话界面交由人类审批启用。
2. **分阶段实施路径（不在单次交付中捆绑全部平面）：**
   - **Phase 1（Local 核心闭环）：** 落地本机 `PluginHost`（含金丝雀故障复现与 `sessionDataDir` 生命周期回收的单共享 `PluginWorker` 子进程）+ `ClientPluginHost`、`running` 态实时工具卡片 + 16 KiB 有界 `tool_call` 历史存储、`lody plugin propose`、HMR 与卸载回退，跑通 `test-report` 与 `worktrees` 端到端验收。
   - **Phase 2（Headless · Web · 多机器与 E2EE 子协议）：** 在 `MachineRpc` 与 [`e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts) 白名单中接入插件方法族（`plugin/catalog`、`plugin/bundle-chunk` 归入只读查询；`plugin/query`、`plugin/mutate` 归入执行鉴权），落地保管域隔离缓存、按客户端信任与 `--dev` 租约、`MachineSharing` 作用域门控及多机器工作区聚合。
   - **Phase 3（多 Session 高级编排与 ACP Runtime 组合）：** 接通 `sessions.send`（含个人设备 `memberInput` 与根 Turn 绑定 `derivedFrom` `machineInput` 签名闭环）、`sessions.requestStop`、`hostQueries.sessionDetail` 以及携带 `acpProviders`（如 Sorbet）的全工作台插件集成。

## 保证

- 能力引用均由宿主签发并在每次读写与宿主动作时重新鉴权；逻辑 `WorkspaceRef` 绝不隐式绑定单台机器，带 `machineId` 的引用在目标机器离线时诚实返回 `machine_offline`，绝不静默漂移至其他机器。
- `ctx.env` 密钥、`ctx.dataDir` 与 `ctx.sessionDataDir` 永不离开所属机器 daemon；在 E2EE 工作区中严格隔离于当前 `<account>/<workspace>/<genesis>/<signing-key>` 保管目录，并在确认成员移除或设备撤销时自动擦除。
- **诚实的进程边界、只读透明重试、金丝雀毒丸隔离与未知结果语义：** 单共享 `PluginWorker` 子进程崩溃或死循环仅中断该机器上在途的插件 `machine` 调用；纯只读调用（`defineQuery`、`defineObservation`）在工作进程重启后透明重试一次，副作用修改/工具调用返回 `outcome_unknown`（严禁调用方自动重放副作用），未归因进程级故障先经金丝雀子进程复现核实再标记 `plugin_faulted`，绝不误杀无辜插件。
- **解耦的前端信任、在途 Turn 稳定与跨端 RPC 一致性：** 远端客户端信任锚定 `clientDigest`，在途 Agent Turn 冻结 `machineDigest` 使纯 UI/Skill 热改不打断长耗时工具执行，`client ↔ machine` RPC 严格受全包 `revision` 门控。
- **独立于归档的请求恢复与 E2EE 执行溯源：** `(workspace, user, target, pluginId, requestId)` 持久回执与按用户/按项目业务键占用原子接受；在 E2EE 工作区中，任何插件发起的会话创建或消息投递均无法绕过个人设备 `memberInput` 或锚定人工根 Turn 的 `derivedFrom` `machineInput` 验签门禁。

## 待定问题

- 原生 iOS 与 Android 客户端（`apps/mobile`）不执行 React `client.js` bundle；移动端是否对部分结构化工具输出提供原生渲染映射留待后续确定。
- E2EE 工作区中，机器拥有者未来是否可将个别只读 `'machine'` 状态摘要显式授权给项目协作者查看（而不放宽通用 `'machine'` 作用域），留待 Phase 2 依据实际协作反馈评估。

## 证据

预期行为：本文档、[插件架构演进收敛与 E2EE 工作区边界](../.agents/notes/proposed/architecture/2026-11-22-plugin-architecture-and-e2ee-boundaries.zh.md)，以及 [`scripts/fixtures/plugin-sdk/sdk/`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts) 下的公开 SDK 声明（[`client.d.ts`](../scripts/fixtures/plugin-sdk/sdk/client.d.ts)、[`machine.d.ts`](../scripts/fixtures/plugin-sdk/sdk/machine.d.ts)、[`manifest.d.ts`](../scripts/fixtures/plugin-sdk/sdk/manifest.d.ts)）。

已核对实现：[`packages/ui/src/index.ts`](../packages/ui/src/index.ts)、[`packages/components/src/components/ai-gui/view.tsx`](../packages/components/src/components/ai-gui/view.tsx)、[`packages/components/src/providers/workspace-machine-rpc-facade.ts`](../packages/components/src/providers/workspace-machine-rpc-facade.ts)、[`packages/shared/src/ai.ts`](../packages/shared/src/ai.ts)、[`packages/shared/src/acp/history-apply.ts`](../packages/shared/src/acp/history-apply.ts)、[`packages/shared/src/acp/tool-call-history.ts`](../packages/shared/src/acp/tool-call-history.ts)、[`packages/shared/src/e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts)、[`packages/shared/src/e2ee-execution-intent.ts`](../packages/shared/src/e2ee-execution-intent.ts)、[`packages/platform/AGENTS.md`](../packages/platform/AGENTS.md)、[`packages/e2ee-machine-sharing/AGENTS.md`](../packages/e2ee-machine-sharing/AGENTS.md)、[`apps/cli/src/lib/e2ee/AGENTS.md`](../apps/cli/src/lib/e2ee/AGENTS.md)、[`apps/cli/src/lib/discovery-query.ts`](../apps/cli/src/lib/discovery-query.ts)、[`apps/cli/src/session/worktree/worktree-observations.ts`](../apps/cli/src/session/worktree/worktree-observations.ts)、[`apps/cli/src/mcp/AGENTS.md`](../apps/cli/src/mcp/AGENTS.md)、[`apps/cli/src/automations/README.md`](../apps/cli/src/automations/README.md)、[`apps/cli/src/automations/programs/codemode.ts`](../apps/cli/src/automations/programs/codemode.ts)、[`packages/shared/src/automations/reads.ts`](../packages/shared/src/automations/reads.ts) 与 [`.agents/docs/failure-containment.md`](../.agents/docs/failure-containment.md)。

验证范围：[`scripts/plugin-sdk-contracts.test.mjs`](../scripts/plugin-sdk-contracts.test.mjs) 分别以纯浏览器配置（[`tsconfig.json`](../scripts/fixtures/plugin-sdk/tsconfig.json)，零 Node 类型）与纯守护进程配置（[`tsconfig.machine.json`](../scripts/fixtures/plugin-sdk/tsconfig.machine.json)，Node 类型且零 DOM 全局对象）编译检查 SDK 声明、四个参考插件（[`test-report`](../scripts/fixtures/plugin-sdk/examples/test-report/client.tsx)、[`issue-context`](../scripts/fixtures/plugin-sdk/examples/issue-context/machine.ts)、[`worktrees`](../scripts/fixtures/plugin-sdk/examples/worktrees/client.tsx)、[`focus-sidebar`](../scripts/fixtures/plugin-sdk/examples/focus-sidebar/client.tsx)）及跨端隔离负向断言（[`contracts.ts`](../scripts/fixtures/plugin-sdk/contracts.ts)、[`machine-contracts.ts`](../scripts/fixtures/plugin-sdk/machine-contracts.ts)）。同一脚本还以真实临时文件验证 Issue 示例按状态文件串行读改写、唯一临时文件替换，以及读取、解析或写入失败时保留原数据；仅 `ENOENT` 返回初始状态。运行时宿主、CLI 命令及 E2EE RPC/保管域执行尚未实现，请求回执与业务键契约尚无生产运行时验收。
