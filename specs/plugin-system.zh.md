# Lody Plugin System 架构设计

Status: draft
Translation: current

[English](plugin-system.md)

Lody 插件系统将功能由官方预先定义好的 Agent Client，演进为可由 Lody 团队、用户以及运行在 Lody 内的 Coding Agent 共同持续塑形的 Agent Workspace。同一个插件包通过同一套公开 SDK（`shared` + 可选 `client` + 可选 `machine`）同时扩展 Agent 的工具能力、Session 内的交互结果界面、多 Session 编排工作流、外部系统上下文注入，以及项目或工作区视图，并原生横跨 **`local`（本地桌面）**、**`web`（浏览器客户端）** 与 **`headless`（无界面守护进程）** 三种运行形态——官方新功能与外部插件共用同一套扩展原语。

本文规定横跨 `local`、`web` 与 `headless` 的宿主架构、公开 SDK 契约及分阶段落地路径。

## 场景

用户在本地桌面或连接远程 `headless` 开发机的 `web` 端让 Agent 现场编写测试分诊插件，或安装议题追踪集成与 Git Worktree 管理器：

1. Agent 在本机或远程 `headless` 机器上运行测试套件后，无论用户在 `local` 桌面还是离线重开的 `web` 浏览器查看该 Session，工具卡片内都直接渲染可筛选的通过/失败表格；勾选失败用例即可将结构化复现摘要追加进当前 Composer 草稿，全程无需再次调用模型。
2. 在 Composer 中输入 `@` 或点击添加附件，客户端通过目标机器 `PluginHost` 持有的凭据搜索外部 Issue，将当前时刻的 Markdown 快照注入本轮输入；同时 Session 右侧伴随面板（即使在未绑定 Project 的普通 Session 中也可按 `SessionRef` 独立查询插件状态）列出关联 Issue，支持在 `headless` 机器上一键创建 24/7 值守、「外部状态就绪时自动唤醒」的等待态 Session，支持跨端按业务意图键找回、追加指令（`sessions.send`）或请求制动（`sessions.requestStop`）。
3. 打开项目的 Worktrees 页面读取目标机器仓库拥有者的活跃 Session Worktree 列表，或在跨机器的 Focus 侧栏按逻辑 `WorkspaceRef` 汇总多台机器上的活跃 Session。

所有 UI 业务操作按目标能力引用直接调用宿主或对应机器上的类型化处理函数，无需伪造 Agent Turn。

## 稳定内核、可组合编排与可塑表面

遵循「宿主内核握有最终准入与制动权，公开 SDK 开放可组合的宿主行动能力」原则，职责严格划分为不可绕过的宿主内核与可塑表面：

| 层次                 | 归属                   | 范围与不变量                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主内核             | Lody 核心独占          | Session 历史写入（`HistoryWriter`）、Inbox 执行准入与防环限制、交互式权限确认框、即时 Stop 制动、机器身份、密钥存储、E2EE 签名边界，以及带安全模式逃生舱的顶层导航壳。插件不能直接改写底层 Loro 文档、替用户静默批准权限或吞掉 Stop。                               |
| 受控宿主编排 API     | 内核授权、插件可组合调 | 创建等待/运行态 Session（`sessions.create`）、向已有 Session 投递或排队消息（`sessions.send`）、请求标准制动与归档（`requestStop` / `requestArchive`），以及读取受限目录与会话详情（`hostQueries`）。所有调用均经宿主既有 Owner 重新鉴权。                          |
| 可塑表面与扩展运行时 | 内置插件与外部插件共用 | Session 工具与结果卡片正文、Composer 附件来源与动作、Session 右侧伴随面板、左侧栏组织视图、项目/工作区/设置页面，以及通过 `acpProviders` 接入的新 Agent Runtime（如 Sorbet，配合 Session 级面板与编排 API 构成完整工作台，绝不在后台脱离 Session 跑隐形自治循环）。 |

每一处可塑表面均由宿主持有安全外框：

- **工具与结果卡片**由宿主保留状态、耗时、权限控件、原始 JSON 切换开关与局部 `ErrorBoundary`；挂载历史输出前先执行 `safeParse`，插件未获当前客户端信任、Schema 不兼容或渲染抛错时自动回退至内置原始视图。
- **左侧栏组织视图**（`lody.sidebar.views.add`）仅替换会话列表组织区，始终保留新建会话、搜索、定时任务与视图切换菜单可达；若受信前端脚本发生渲染抛错由 `ErrorBoundary` 立即回退，若发生同步主线程卡死则可通过宿主顶层安全模式参数一键禁用插件重开（不影响守护进程侧 `HistoryWriter` 与 CLI/远端 Stop）。
- **独立页面**（`/w/:w/m/:m/projects/:p/plugins/:pkg/:id` 及对应工作区/设置路由）将插件定位状态编码为独立的 `p.<key>` 查询参数，支持刷新与前进后退恢复，但 URL 参数本身不授予任何数据访问权限。

## 一套契约，三种运行形态（Local · Web · Headless）

参照 Paseo 的 `shared / server / client` 切分并与 Lody 平台装配契约（[`AGENTS.md`](../AGENTS.md#repository-boundary)、[`packages/platform/AGENTS.md`](../packages/platform/AGENTS.md#composition-and-capabilities)）对齐：机器侧 `PluginHost` 位于 `apps/cli` daemon，界面侧 `ClientPluginHost` 位于 `@lody/components`，通过传输无关的 `MachineRpc`（本机 `LocalMachineRpc` IPC 或远程 [`WorkspaceMachineRpcFacade`](../packages/components/src/providers/workspace-machine-rpc-facade.ts)）衔接。

为了在多机器工作区中消除「逻辑数据范围」与「执行机器位置」的混淆，能力引用严格区分两类作用域（[`sdk/shared.d.ts`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)）：

- **逻辑工作区作用域（`WorkspaceRef { workspaceId }`）：** 不绑定单一 `machineId`。`hostQueries.machines`、`hostQueries.projects` 与工作区级 `hostQueries.sessions` 直接读取客户端已同步的工作区目录视图——单台机器离线绝不会拖垮整个工作区侧栏；跨机器工作区页面可通过 `hostQueries.machines` 枚举在线 `MachineRef` 按机器显式扇出查询。
- **机器执行作用域（`MachineRef`、`ProjectRef`、`SessionRef`）：** 均携带确切 `machineId`。插件自定义的 `defineQuery`、`defineMutation` 与 `defineObservation` 统一限定在 `MachinePluginScope`（`'machine' | 'project' | 'session'`），使 `'session'` 成为真正的一等作用域（包括未绑定 Project 的普通 Session）。

| 组件                                  | 职责                                                                                                                                                                                             | 执行模型与故障边界                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lody/plugin-sdk`                    | 跨端共享描述子、宿主只读目录 `hostQueries`（含 `machines`、`sessionDetail`）及四级品牌能力引用（`WorkspaceRef`、`MachineRef`、`ProjectRef`、`SessionRef`）。                                     | 纯类型契约与宿主运行时映射；编译期强制 `client` 零 Node 依赖、`machine` 零 DOM 依赖且互不跨端导入。                                                                                                                                                                                                     |
| `apps/cli` `PluginHost`               | 管理机器安装记录 `(workspace, machine, pluginId)`、双摘要（`clientDigest` 与全包 `revision`）、密钥 `env`、私有目录 `dataDir`、内置插件 MCP 路由、宿主目录适配，以及静态托管预编译 `client.js`。 | 每台机器所有已启用的 `machine` 模块共享**单个 `child_process.fork` 辅助进程**（`PluginWorker`）：隔离原生崩溃/OOM 不波及主 daemon，并在多次 HMR 后择机滚动重建以彻底释放旧 ESM 模块图；同步死循环由看门狗重启该共享进程，连续崩溃的肇事插件自动标记为 `plugin_faulted` 毒丸隔离，保障其余正常插件恢复。 |
| `@lody/components` `ClientPluginHost` | 在桌面窗口或浏览器标签页按 `(machineId, pluginId, clientDigest)` 评估已信任的纯浏览器 ESM `client.js`，注入宿主 `react`、`@lody/ui`、`@lody/plugin-sdk` 与 `zod`（Zod 4），按 `machineId` 路由。 | 渲染进程/浏览器主线程内 React 执行；每次激活绑定当前包 `revision`，版本变更或在线收到停用通知时中止旧订阅并执行可选清理回调。                                                                                                                                                                           |

三种运行形态复用同一套插件产物（同时支持全栈、纯 `headless` 机器插件与纯 `client` 视图插件）：

| 运行形态   | 活跃宿主组件                           | 安装、传输与缓存模型                                                                                                                                    | 信任边界与离线退化行为                                                                                                                                                                                                                       |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`    | `ClientPluginHost` + 本机 `PluginHost` | OSS 桌面端通过本机 `LocalMachineRpc` IPC 直连内嵌/本机 CLI daemon，零云服务依赖；启用 `remoteMachines` 时亦可挂载同一工作区内远程 `headless` 机器插件。 | 本机用户启用的本机插件直接受信；挂载共享/远程机器插件时沿用按客户端 `(pluginId, clientDigest)` 信任门控。                                                                                                                                    |
| `headless` | 仅 `apps/cli` `PluginHost`（零窗口）   | 运行于服务器、容器或远程开发机（`lody start`），通过 `lody plugin` CLI 管理；持续承载 Agent 工具、24/7 `defineObservation` 与 `waiting` Session。       | 拥有该机器 daemon 所在 OS 用户权限，`ctx.env` 与 `ctx.dataDir` 永不离开该机器；即使无任何 `local` / `web` 客户端在线，Agent 工具与自动化观察仍独立运行。                                                                                     |
| `web`      | 仅浏览器 `ClientPluginHost`（无守护）  | 经专用受控 `MachineRpc` 插件方法拉取预编译 `client.js` 与 `assets/`，校验 `clientDigest`（SHA-256）后不可变缓存于 IndexedDB。                           | 远端目录记录绝不在浏览器内自动执行 JS：正式包按 `(pluginId, clientDigest)` 显式确认信任，开发态（`--dev`）授予有期限的 `(machineId, pluginId)` 开发会话租约避免每次 HMR 重复弹窗；在线停用即时撤销，离线期间允许已缓存卡片只读渲染历史输出。 |

### 纯浏览器前端约束、双哈希职责切分与在途 Turn 规则

1. **`client.js` 纯浏览器可移植边界：** `client` 固定以 `platform: 'browser'` 编译为标准 ESM（仅外部化 `react`、`react/jsx-runtime`、`@lody/plugin-sdk`、`@lody/ui` 与 `zod`），编译期禁止导入 Node 内置模块、Electron preload 专属对象、`file://` 路径与 `machine` 模块。
2. **双内容哈希解耦「前端缓存/信任」与「全包执行一致性」（零人工维护）：**
   - **`clientDigest` = `SHA-256(client.js + assets/)`：** 专管浏览器 IndexedDB 缓存键与远端前端代码信任确认。仅修改 `machine.ts`、`skills/` 或版本号时 `clientDigest` 不变，`web` 客户端无需重下 bundle，更不会重复弹出信任确认框。
   - **`revision` = `SHA-256(lody.plugin.json + client + machine + assets + skills)`：** 完整分发产物身份，专管跨端 RPC 与工具执行的语义一致性（不依赖脆弱的纯 Zod Schema 比对）。客户端请求携带 `(pluginId, revision)`，滞后旧 UI 请求以 `revision_mismatch` 拒绝；正在运行的 Agent Turn 在启动时冻结当时的 `(pluginId, revision)` 快照，若 Turn 中途插件热更新改变了 `revision`，旧 Turn 后续调用该插件工具直接返回明确版本变更错误，绝不在同一 `ctx.dataDir` 上双开新旧两版 handler，新工具定义于下一 Turn 生效。
3. **开发态（`--dev`）与分发态（`pack`）：** `--dev` 由机器 daemon 内置 `esbuild` 内存编译，切换前在宽限期内执行旧版清理回调，超时则直接回收共享 `PluginWorker` 子进程（插件自行 `spawn` 的外部进程须绑定父进程退出清理）。`lody plugin pack` 产出离线归档，导入时零源码编译、零安装脚本、零联网下载。

## 五个正交原语与历史存储契约

1. **合一工具声明与有界历史载荷（`defineTool`）：** 在共享模块中一次性声明工具的 Zod `input` 与 `output`（[`sdk/shared.d.ts`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)）。由于现有 [`history-apply.ts`](../packages/shared/src/acp/history-apply.ts) 会剥离普通 ACP 工具无界的 `rawOutput`，内置插件 MCP 路由在工具完成时将通过 `output` Schema 校验的结果写入专用的有界 `tool_call` 插件字段（`{ pluginId, toolId, producerRevision, output }`），硬上限为 **`MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES`（16 KiB UTF-8）**，随 Loro Session History 持久同步（[测试报告示例](../scripts/fixtures/plugin-sdk/examples/test-report/client.tsx)）。超过 16 KiB 的大体积结果由插件写入 `ctx.dataDir`，仅在 `output` 中返回摘要与查询键，展开时通过 `defineQuery('session' | 'project', ...)` 按需拉取，无需引入独立的全局 Artifact Store。
2. **Composer 上下文与动作（`defineAttachmentSource` 与 `composer.actions`）：** `machine.attachmentSource` 利用目标机器 daemon 独有的 `ctx.env` 凭据检索外部或本机数据，并将结构化 Markdown 快照注入当前草稿（[Issue 上下文示例](../scripts/fixtures/plugin-sdk/examples/issue-context/machine.ts)）。
3. **分作用域读写与宿主目录（`defineQuery`、`defineMutation`、`hostQueries`）：** 插件查询限定于 `'machine' | 'project' | 'session'` 作用域，统一返回四态 `QueryResult<T>`（`loading | ready | unavailable | error`）并保留三态可达性（`machine_offline | unknown | forbidden`）。共享 `hostQueries` 向 `client` 与 `machine` 暴露现有拥有者的受限只读投影：`machines`、`projects`、`sessions`、`sessionDetail`（受限的最近 Turn 摘要与等待态信息）、`worktrees`（[`worktree-observations.ts`](../apps/cli/src/session/worktree/worktree-observations.ts)）与 `pullRequests`——见 [Worktrees 示例](../scripts/fixtures/plugin-sdk/examples/worktrees/client.tsx)与跨机器 [Focus 侧栏示例](../scripts/fixtures/plugin-sdk/examples/focus-sidebar/client.tsx)。
4. **Session 编排、非归档幂等创建与目录找回（`sessions.create` / `send` / `requestStop`）：** `sessions.create` 在**未归档（`archived === false`）**会话范围内按 `(workspace, user, project, pluginId, idempotencyKey)` 去重（归档旧会话后可自然使用同一业务键重建；同键异参返回 `idempotency_conflict`），并与 `hostQueries.sessions` 的 `(createdByPluginId, idempotencyKey)` 元数据共享同一原子提交边界，崩溃或换用无状态 `web` 打开均可直接从目录找回（[Issue 面板示例](../scripts/fixtures/plugin-sdk/examples/issue-context/client.tsx)）。`sessions.send` 按 `(session, pluginId, idempotencyKey)` 经既有 Session Inbox 准入（遵循防自发死循环与深度上限 [`apps/cli/src/mcp/AGENTS.md`](../apps/cli/src/mcp/AGENTS.md)）排队或引导下一轮，`sessions.requestStop` 委托宿主执行标准即时制动。
5. **Automation 衔接（`defineObservation` 与等待态 Session）：** 插件通过 `defineObservation` 向所在机器 [`automations`](../apps/cli/src/automations/README.md) 注册只读观察源（`ctx.read('plugin.<pluginId>.<id>', input)`），使 `headless` 机器天然胜任 24/7 值守。创建等待态 Session 时可通过插件自身本地 observation 驱动唤醒（明文与 E2EE 工作区均可用），或通过 `CreateSessionRequest.pullRequestUrl` 显式绑定初始 PR 供明文工作区的 `github.*` 观察源读取（E2EE 工作区不注册 PR poller，`github.*` 保持 `unknown`）。

首版明确不包含跨插件 UI 插槽协商（`defineSlot`）；所有插件统一向宿主扩展点注册。

## 面向 AI 的插件自举与分阶段交付路线

1. **同源 Skill 与双端边界自检：** 内置 `lody-plugin-dev` Skill 直接从当前 SDK `.d.ts` 生成 API 参考；`lody plugin init` 生成最小工程；`lody plugin check` 同时校验浏览器端（零 Node 依赖）与机器端（零 DOM 依赖）打包及清单诊断；`lody plugin preview <dir> --fixture <json> [--headless]` 支持桌面实时预览与 `headless` 服务器无头冒烟校验，全程无需调用大模型。
2. **分阶段实施路径（不在单次交付中捆绑全部平面）：**
   - **Phase 1（Local 核心闭环）：** 落地本机 `PluginHost`（单共享 `PluginWorker` 子进程）+ `ClientPluginHost`、16 KiB 有界 `tool_call` 历史存储、HMR 与卸载回退，跑通 `test-report` 与 `worktrees` 端到端验收。
   - **Phase 2（Headless · Web · 多机器与 E2EE 子协议）：** 在 `MachineRpc` 与 [`e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts) 受控白名单中显式定义插件方法族（`plugin/catalog`、`plugin/bundle-chunk`、`plugin/query`、`plugin/mutate`），落地 `clientDigest` IndexedDB 缓存、按客户端信任与 `--dev` 租约，以及多机器工作区聚合。
   - **Phase 3（多 Session 高级编排与 ACP Runtime 组合）：** 接通 `sessions.send`、`sessions.requestStop`、`hostQueries.sessionDetail` 以及携带 `acpProviders`（如 Sorbet）的全工作台插件集成。

## 保证

- 能力引用均由宿主签发并在每次读写与宿主动作时重新鉴权；逻辑 `WorkspaceRef` 绝不隐式绑定单台机器，带 `machineId` 的引用在目标机器离线时诚实返回 `machine_offline`，绝不静默漂移至其他机器。
- `ctx.env` 密钥与 `ctx.dataDir` 永不离开所属机器 daemon。
- **诚实的进程边界、毒丸隔离与未知结果语义：** 单共享 `PluginWorker` 子进程崩溃或死循环仅中断该机器上在途的插件 `machine` 调用；若崩溃发生在副作用 handler 派发之后、回执写入之前，宿主返回 `outcome_unknown`（严禁调用方自动重放副作用），连续引发崩溃的插件自动以 `plugin_faulted` 隔离停用，不影响主 daemon、`HistoryWriter` 或其他正常插件。
- **解耦的信任与跨热替换语义安全：** 远端客户端信任精确锚定 `clientDigest`（纯后端改动不重弹信任，开发态使用有期限会话租约）；RPC 与在途 Turn 工具调用严格受全包 `revision` 门控。
- **无裂脑的非归档幂等会话找回：** `(workspace, user, project, pluginId, idempotencyKey)` 的去重接受与 `hostQueries.sessions` 可见性原子一致。

## 待定问题

- E2EE 工作区开放跨机器插件 RPC（扩展 [`e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts) 白名单方法及 `client.js` / `assets/` 分片帧上限）须在 Phase 2 单独完成加密边界与远程控制策略评审后启用。
- 原生 iOS 与 Android 客户端（`apps/mobile`）不执行 React `client.js` bundle；移动端是否对部分结构化工具输出提供原生渲染映射留待后续确定。

## 证据

预期行为：本文档及 [`scripts/fixtures/plugin-sdk/sdk/`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts) 下的公开 SDK 声明（[`client.d.ts`](../scripts/fixtures/plugin-sdk/sdk/client.d.ts)、[`machine.d.ts`](../scripts/fixtures/plugin-sdk/sdk/machine.d.ts)、[`manifest.d.ts`](../scripts/fixtures/plugin-sdk/sdk/manifest.d.ts)）。

已核对实现：[`packages/ui/src/index.ts`](../packages/ui/src/index.ts)、[`packages/components/src/components/ai-gui/view.tsx`](../packages/components/src/components/ai-gui/view.tsx)、[`packages/components/src/providers/workspace-machine-rpc-facade.ts`](../packages/components/src/providers/workspace-machine-rpc-facade.ts)、[`packages/shared/src/ai.ts`](../packages/shared/src/ai.ts)、[`packages/shared/src/acp/history-apply.ts`](../packages/shared/src/acp/history-apply.ts)、[`packages/shared/src/acp/tool-call-history.ts`](../packages/shared/src/acp/tool-call-history.ts)、[`packages/shared/src/e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts)、[`packages/platform/AGENTS.md`](../packages/platform/AGENTS.md)、[`apps/cli/src/lib/discovery-query.ts`](../apps/cli/src/lib/discovery-query.ts)、[`apps/cli/src/session/worktree/worktree-observations.ts`](../apps/cli/src/session/worktree/worktree-observations.ts)、[`apps/cli/src/mcp/AGENTS.md`](../apps/cli/src/mcp/AGENTS.md)、[`apps/cli/src/automations/README.md`](../apps/cli/src/automations/README.md)、[`packages/shared/src/automations/reads.ts`](../packages/shared/src/automations/reads.ts) 与 [`.agents/docs/failure-containment.md`](../.agents/docs/failure-containment.md)。

已执行验证：[`scripts/plugin-sdk-contracts.test.mjs`](../scripts/plugin-sdk-contracts.test.mjs) 分别以纯浏览器配置（[`tsconfig.json`](../scripts/fixtures/plugin-sdk/tsconfig.json)，零 Node 类型）与纯守护进程配置（[`tsconfig.machine.json`](../scripts/fixtures/plugin-sdk/tsconfig.machine.json)，Node 类型且零 DOM 全局对象）编译检查 SDK 声明、四个参考插件（[`test-report`](../scripts/fixtures/plugin-sdk/examples/test-report/client.tsx)、含 `ctx.dataDir` 原子持久化的 [`issue-context`](../scripts/fixtures/plugin-sdk/examples/issue-context/machine.ts)、[`worktrees`](../scripts/fixtures/plugin-sdk/examples/worktrees/client.tsx)、[`focus-sidebar`](../scripts/fixtures/plugin-sdk/examples/focus-sidebar/client.tsx)）及跨端隔离负向断言（[`contracts.ts`](../scripts/fixtures/plugin-sdk/contracts.ts)、[`machine-contracts.ts`](../scripts/fixtures/plugin-sdk/machine-contracts.ts)）。运行时宿主与 CLI 命令尚未实现。
