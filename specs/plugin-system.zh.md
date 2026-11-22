# Lody 插件系统

Status: draft
Translation: current

[English](plugin-system.md)

Lody 插件把固定功能的 Agent 客户端扩展为可塑的 Agent 工作台。通过一套统一公开 SDK（`shared` + 可选 `client` + 可选 `machine`），单个插件包即可扩展 Agent 可调用工具、Session 卡片与伴随面板、基于原始数据 SDK 的三层可组合侧边栏与全屏画布、双层主题与本地自定义 CSS 外观体系，以及项目级页面视图——按契约覆盖 **`local`（桌面一体）**、**`headless`（纯守护进程）** 与 **`web`（纯浏览器客户端）** 三种拓扑。

本规范定义插件宿主与子进程生命周期契约、最小完备公开 SDK、双层主题与 CSS 边界、端到端加密（E2EE）工作区安全规则及分阶段真实进程验收标准。架构取舍与被推翻的过度设计记录于 [插件架构收敛与 E2EE 工作区边界](../.agents/notes/proposed/architecture/2026-11-22-plugin-architecture-and-e2ee-boundaries.zh.md)。

## 场景

开发者在桌面端（`local`）或连接远端 `headless` 开发机时安装测试分诊插件、Issue 上下文集成，或启用多 Agent 侧边栏与主题包：

1. Agent 在目标机器上运行测试套件时，会话流中的工具卡片立即以 `running` 状态挂载并通过作用域查询展示实时进度，避免高频流式写入撑爆 Loro CRDT 历史；执行完成后，无论在桌面端还是离线重开的客户端打开该 Session，都能基于有界历史快照渲染可筛选表格、打开伴随详情面板，或把勾选失败项追加进 Composer 草稿而无需额外消耗一次 LLM Turn。
2. 在 Composer 输入 `@` 搜索附件时，请求经目标机器的 `PluginHost` 使用机器本地凭据检索外部 Issue 并插入时间点 Markdown 快照；Session 右侧伴随面板按任务业务键查看、新建或打开关联 Session，直接发送追问（`sessions.send`）或请求停止（`sessions.requestStop`）。
3. 多 Agent 视图与主题插件为日常会话行挂载 `? Input` 徽章与多步悬停问答气泡（`sidebar.sessionRow.decorate` + `lody.sessions.answerQuestion`，原地回答后台 `ask_user_question` 而不打断当前会话），注册顶部 `<SidebarRow />` 全屏看板入口（`screens.add`）及可切换的自定义侧边栏树视图（`sidebar.views.add`，其 `<SessionRow />` 自动继承全部行级装饰器）；同时通过稳定主题 Token（`manifest.themes` / `lody.themes.add`）与宿主托管本地 CSS 片段（`manifest.styles` / `lody.styles.add`）深度定制字体、圆角、紧凑度与界面视觉。

所有 UI 交互均直接发往强类型宿主或绑定具体 `machineId` 的插件处理函数，绝不伪造隐藏的用户消息去驱动后台逻辑。

## 内核、原始数据 SDK 与可塑界面边界

遵循「**宿主内核保底核心准入与急停控制权，公开 SDK 暴露原始响应式数据与可组合动作，界面与外观层保持高可塑性**」原则，职责划分为三层：

| 层级                        | 归属                 | 范围与不变量                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 宿主内核                    | 仅 Lody 核心         | 会话历史写入（`HistoryWriter`）、Inbox 准入与防死循环上限、工具权限审批弹窗、立即 Stop、机器身份与密钥保管、E2EE 签名校验，以及顶层逃生舱（`lody --safe-mode`）。插件不可直写底层 Loro 文档、不可代批工具 `permission`、不可吞掉 Stop。                                                                                                                                        |
| `LodyClient` 与原始数据 SDK | 内核门控、前后端对称 | 前端 `useLody()` 与守护进程 `ctx.lody` 对称暴露 `lodyQueries`（前端经 `useLodyQuery` 零拷贝订阅 Loro/Flock 房间或复用 `MachineRpc` 只读通路）及受控动作：`sessions.create` / `send` / `answerQuestion`（仅限 `ask_user_question`）/ `requestStop` / `requestArchive`、`drafts.open` / `append`、`panels.openSession`、`screens.open`、`pages.openProject`、`themes.activate`。 |
| 可塑界面与双层外观系统      | 内置与外部插件       | 工具卡片（`tools.render`）、Composer 附件与动作、Session 面板、三层正交侧边栏（`sidebar.sessionRow`、`headerItems`/`footerItems`、`sidebar.views`）+ 主区 `screens`、项目与设置页、稳定主题契约（`themes`）及宿主托管本地自定义 CSS（`styles`）。                                                                                                                              |

每个扩展面均保留宿主兜底而不阉割表达力：

- **极薄组件入参、按需拉取原始数据：** 界面组件仅接收最小能力引用（`workspace`、`project`、`session`）与只读路由 `params`，绝不向 props 预塞原始业务状态；所需目录或机器状态统一经 `useLodyQuery`（宿主内建查询）与 `useQuery`（插件自定义查询）按需订阅。
- **工具卡片兜底：** 宿主始终渲染外层状态栏、耗时、权限控件、原始 JSON 切换开关与独立 `SurfaceErrorBoundary`；完成态数据经 Zod `safeParse` 校验后再挂载插件组件，未信任、校验不匹配或渲染抛错时自动回退至宿主原始视图。
- **三层正交侧边栏（基于 [`sidebar-surface.ts`](../packages/components/src/components/sidebar-surface.ts)）：** 摒弃互相覆盖的单例 `sidebar.replace`：（1）`sidebar.sessionRow.decorate` 为会话行挂载尾部徽章与悬停气泡；（2）`sidebar.headerItems` / `footerItems` 搭配原生 `<SidebarRow />` 与主区 `screens.add`；（3）`sidebar.views.add` 注册可并存切换的完整自定义侧边栏视图，内部渲染 `<SessionRow />` 时自动继承所有已启用的行级装饰器，且宿主保留顶层视图切换器。
- **类 Obsidian 双层主题与外观系统：** 在信任且非沙箱的前端插件模型下，`client.js` 天然运行于主线程并持有 DOM 访问权，靠删除 CSS 接口无法构造安全沙箱，反而迫使插件私自往 `document.head` 泄漏不受管样式。因此外观定制明确划分为两层：（1）**稳定 SemVer 主题契约（`manifest.themes`、`lody.themes.add`、`lody.themes.activate`）**，支持完整 VS Code 主题 JSON 或紧凑种子色板（`PluginThemeSeedColors`）及非颜色设计 Token（`PluginThemeTokens`：字体、圆角、`density` 紧凑度），统一经 [`vscode-theme-dom.ts`](../packages/components/src/lib/vscode-theme/vscode-theme-dom.ts) 派生并注入根级 CSS 变量（`--*`）；（2）**宿主托管本地自定义 CSS（`manifest.styles`、`lody.styles.add`）**，仅对主动开启的当前本地客户端生效（绝不自动同步至其他协作者浏览器），由宿主按插件实例统一挂载并在停用/HMR 时干净移除，支持 `lody --safe-mode` 一键旁路；**跨版本兼容性仅承诺公开 CSS 变量（`--*`），不锁死内部 React DOM 层级结构**。

## 跨拓扑运行与能力引用模型

Lody 插件属于**用户显式安装并信任的非沙箱代码（Trusted, Unsandboxed Code）**，通过进程隔离、确定性回收与权限门控控制风险：

| 拓扑                     | `client` 入口                                                | `machine` 入口                                  | 核心行为                                                                                                                    |
| ------------------------ | ------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `local`（桌面一体）      | 本地客户端窗口内执行                                         | 本机守护进程按插件独立子进程执行                | Phase 1 完整闭环；支持 `--dev` 监听构建、HMR 与本地自定义主题/CSS。                                                         |
| `headless`（纯守护进程） | 不加载（零浏览器开销）                                       | 远端守护进程按插件独立子进程执行                | 纯后端运行 `defineTool`、`defineQuery`、`defineMutation`、`defineAttachmentSource` 与 `skills/`。                           |
| `web`（纯浏览器客户端）  | Phase 1 回退内置原始视图；Phase 2 按 `clientDigest` 信任挂载 | 经 `MachineRpc` 路由至目标 `machineId` 守护进程 | 严禁浏览器直连第三方 API 或持有 `ctx.env` 密钥；目标机器离线时返回 `{ status: 'unavailable', reason: 'machine_offline' }`。 |

能力引用（`WorkspaceRef`、`MachineRef`、`ProjectRef`、`SessionRef`）由宿主签发并在每次调用时重新鉴权：

- **逻辑 `WorkspaceRef`（不含 `machineId`）：** 工作区级视图（如多机器侧边栏与全局看板）通过 `useLodyQuery(workspace, lodyQueries.machines | projects | sessions | agentRoles)` 直接订阅已同步目录房间，单台机器离线时依然即时可用；仅在对特定机器或项目发起实时插件调用时才传入绑定 `machineId` 的引用。
- **插件后端作用域限定 `'machine' | 'project' | 'session'`：** `defineQuery` 与 `defineMutation` 必须显式绑定单台机器及其归属范围，不做跨机器隐式广播或静默故障转移。

## 运行时与进程生命周期契约（Runtime Lifecycle Contract）

为避免共享 Worker 引发跨插件连坐崩溃、无归属死循环/OOM 与复杂的金丝雀复现机制，`PluginHost` 采用**按插件独立子进程 + 串行排空回收 + Fail-Stop** 模型：

1. **进程隔离与零僵尸编译器：**
   - 每个已启用且声明了 `machine` 入口的插件独占一个 `child_process.fork` 子进程；纯前端或纯主题/Skill 插件（无 `machine` 入口）占用 **`0` 个后端子进程**。
   - `--dev` 模式下的 `esbuild` 编译放入按需拉起、空闲 `1s` 自动退出的独立短生命周期编译子进程，主守护进程常驻堆不加载打包器，且关闭时绝不残留僵尸 `esbuild` 进程。
2. **单队列生命周期与 Drain-Before-Respawn（旧死新方生）：**
   - 每个 `pluginId` 的 `start` / `reload` / `stop` / `remove` 进入单串行异步队列，消除并发热重载竞态。
   - 停止或替换旧实例严格执行 **`shutdown` IPC → 最多等待 `2s` → `SIGTERM` → 最多等待 `2s` → `SIGKILL`**，且在等待退出期间不提前调用 `child.disconnect()` 以确保 `close` 事件可靠触发；**旧 OS 进程未彻底退出前，绝不启动替代新进程**，杜绝新旧进程并发踩踏同一 `ctx.dataDir`。
3. **单层扁平 IPC、确定性超时与 Fail-Stop（零自动重试）：**
   - 宿主与插件子进程之间直接收发单层类型化 IPC 消息（`init`、`query`、`mutate`、`tool`、`attachment`、`invalidate`、`cancel`、`shutdown`），不在 Node IPC 之上嵌套二层 WebSocket 隧道。
   - `query` / `mutate` / `attachment` 默认硬超时 `30s`，`tool` 默认硬超时 `10min`；前端卸载或用户点击 `Stop` 时发送 `cancel(callId)` 触发子进程对应调用的 `ctx.signal.abort()`。
   - 子进程异常退出、启动失败或收到非法 IPC 载荷时执行 **Fail-Stop**：立即摘除当前插件实例、拒绝全部在途请求（在途 `defineMutation` 与 `defineTool` 统一返回 `outcome_unknown`，`defineQuery` 直接报错，**宿主对读写均不做隐式自动重试**），将插件标记为 `plugin_faulted` 直至用户显式 `reload`，并保留有界环形诊断日志（上限 `500` 行 / `256 KiB`、单行截断 `16 KiB`）。
4. **`clientDigest` 与运行时 `instanceId`（取代三哈希与 `revision_mismatch`）：**
   - 前端产物按 `clientDigest = SHA-256(client.js + assets/)` 寻址与校验信任：当 `--dev` 重编译后 `clientDigest` 未变（例如仅改动 `machine.ts` 或 `skills/`），前端保留既有插件挂载实例、`AbortController` 与查询缓存，避免界面无故闪烁重置；当 `clientDigest` 变化时，先调用旧实例清理函数并 `abort()` 旧订阅与托管 `<style>`，再原子切换新实例。
   - 后端每次启动 `machine` 子进程分配单调运行时 `instanceId`：仅修改 `client.tsx`、主题或 `skills/` 不会重启 `machine` 子进程，正在执行的 Agent Turn 零中断；若显式重载 `machine` 子进程，在途请求按上述排空规则终止并返回明确错误，无需引入整包 `revision_mismatch` 锁死前端开发。

## 核心扩展原语、有界历史与安全安装规则

插件包由 `lody.plugin.json`（[`sdk/manifest.d.ts`](../scripts/fixtures/plugin-sdk/sdk/manifest.d.ts)）、共享契约（[`sdk/shared.d.ts`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)）、纯浏览器前端入口（[`sdk/client.d.ts`](../scripts/fixtures/plugin-sdk/sdk/client.d.ts)）与纯 Node 机器入口（[`sdk/machine.d.ts`](../scripts/fixtures/plugin-sdk/sdk/machine.d.ts)）组成：

- **四项机器侧运行时原语：** `defineTool`（经内建 MCP 桥暴露为 `plugin__<plugin_id>__<tool_id>`）、`defineQuery`、`defineMutation`（配合 `ctx.invalidate` 精准刷新订阅）与 `defineAttachmentSource`。
- **16 KiB 有界历史快照 + 单一 `ctx.dataDir`：** 完成态 `defineTool` 输出内联写入 Session 历史的上限为 **`MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES`（16 KiB）**；运行态增量进度或超大产物统一以不可变 `toolCallId` 为键写入插件安装级持久化目录 `ctx.dataDir` 并通过 `defineQuery` 按需读取，避免污染 Loro CRDT 或耦合 `session/fork` 目录复制。
- **幂等建会契约（`requestId` + 用户级 `businessKey`）：** `sessions.create` 必填不可变 `requestId`，宿主在 `(workspace, user, target, pluginId, requestId)` 下持久化请求回执（归档后重放同一请求仍返回原 `SessionRef`，参数篡改报 `idempotency_conflict`）；可选 `businessKey` 在同一用户命名空间下防止重复开启活跃任务（冲突报 `business_key_conflict`，Session 归档后释放活跃占位而不擦除原 `requestId` 回执）。
- **严格仅限人类安装与启用：** 插件的安装、启用、停用与重载入口仅暴露在人类直接操作的本地 CLI 与桌面设置页中，**严禁暴露在 Agent MCP 工具面**，从根源阻断 Agent 编写代码后自我安装提权。

## 加密工作区（E2EE）插件安全边界

在 E2EE 工作区（[`specs/e2ee-foundations.zh.md`](e2ee-foundations.zh.md)）中，插件须严守六条硬边界：

| 边界维度                           | E2EE 插件规则                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 访客（`read`）与写者 RPC 隔离      | 因方法名无法证明子进程代码无副作用（[`e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts)），`plugin/query`、`plugin/mutate` 与 `plugin/attachment-*` 绝不进入 `E2EE_READ_QUERY_METHODS`，一律要求非访客 `authorizeExecution`（`<15 分钟` 账本新鲜度）；访客端调用插件 `useQuery` 诚实收敛为 `{ status: 'unavailable', reason: 'forbidden' }`，仅可渲染历史内联 ≤16 KiB 快照与宿主受控 `useLodyQuery` 只读数据。                                                                                                  |
| 机器拥有者独占与 `MachineSharing`  | E2EE 机器按项目共享（[`specs/e2ee/machine-sharing.zh.md`](e2ee/machine-sharing.zh.md)）。插件安装/启停、`binding: 'installation'` 设置、`ctx.env` 密钥及 `'machine'` 作用域调用**仅限机器拥有者本人**；项目协作者仅在 `MachineSharing` 实时授权该机器及目标全部关联项目时方可调用 `'project'` 与 `'session'` 作用域处理函数。                                                                                                                                                                                   |
| 签名 `e2eeIntent` 与 20 次派生配额 | 前端 `useLody().sessions.create` / `send` 在个人设备签发 `memberInput`（`kind = 1`，[`e2ee-execution-intent.ts`](../packages/shared/src/e2ee-execution-intent.ts)）；`sessions.answerQuestion` 仅提交 `ask_user_question` 答复而绝不代批工具 `permission`。守护进程仅允许处于活跃人工根 Turn 内的 `ToolExecutionContext` 签发携带 `derivedFrom` 的 `machineInput`（`kind = 2`，受共享成员 20 次派生上限与禁止跨机派生约束）；无人工根 Turn 的 `MachineContext` 调用 `create` / `send` 一律拒绝（`forbidden`）。 |
| 256 KiB Iroh 单帧快路径与分片上限  | `MAX_PLUGIN_RPC_REQUEST_BYTES`（256 KiB）确保桌面直连 `plugin/query` 与 `plugin/mutate` 落在单个 1 MiB `purpose 8` Iroh 快路径帧内；远端前端产物包上限为 `MAX_PACKED_CLIENT_BUNDLE_BYTES`（4 MiB），Phase 2 接入远端分发时直接复用既有 256 KiB `purpose 9` 分页通道。                                                                                                                                                                                                                                           |
| 保管域隔离与撤销擦除               | E2EE 守护进程 `ctx.dataDir` 必须位于 `<account>/<workspace>/<genesis>/<signing-key>` 专属身份目录下（[`apps/cli/src/lib/e2ee/AGENTS.md`](../apps/cli/src/lib/e2ee/AGENTS.md)）；Phase 2 落地的客户端产物与信任缓存同样绑定该保管域（[`client-custody.zh.md`](e2ee/client-custody.zh.md)、[`desktop-custody.zh.md`](e2ee/desktop-custody.zh.md)），在工作区模式 `unknown` 时禁止挂载，并在确认成员移除或设备撤销时原子擦除。                                                                                     |
| 脱敏、明文分享与零云端令牌         | Presence 白名单与遥测剥离全部插件 ID、工具名与异常堆栈。明文静态 Session 分享仅包含历史内联 ≤16 KiB 结果且匿名端固定渲染宿主内置结构化回退视图，绝不上传 `ctx.dataDir` 或执行第三方 `client.js`。E2EE 插件不获注入云端托管令牌，启用含 `env` 或 `attachmentSource` 的插件时显式披露本机网络外发权限。                                                                                                                                                                                                           |

## 分阶段交付、明确延后项与真实进程 E2E 验收

1. **Phase 1（本机最小完备运行时 + 双层主题外观 + 真实进程/浏览器 E2E）：**
   - 落地守护进程 `PluginHost`（每插件独立 `child_process.fork`、`shutdown → 2s SIGTERM → 2s SIGKILL` 串行排空回收、环形日志、空闲退出的 `--dev` 编译子进程）与前端 `ClientPluginHost`（按 `clientDigest` 替换实例、`AbortController` 订阅清理、`SurfaceErrorBoundary`、`lody --safe-mode`）。
   - 落地 `useLody` / `ctx.lody`、`lodyQueries` + `useLodyQuery`、四项核心机器原语、16 KiB 有界历史 + `ctx.dataDir`、三层侧边栏 + `sessions.answerQuestion`、以及类 Obsidian 双层主题（`themes` Token + 托管 `styles` CSS），内置迁移并验收 `test-report`、`worktrees`、`focus-sidebar` 与 `issue-context`。
   - **Phase 1 必过真实进程与浏览器 E2E 验收矩阵：**
     1. _Drain-Before-Respawn_：捕获 `SIGTERM` 不退出的慢插件在 `reload` 时必须完整走完 `SIGKILL` 退出后，新进程 PID 才允许启动。
     2. _挂起进程强杀与零僵尸_：死循环子进程在 `stop` 后 `4s` 内被 `SIGKILL` 回收；`--dev` 编译器空闲自动退出无残留进程。
     3. _在途请求确定性失败_：子进程崩溃或被 `stop` 时，挂起的 `query` 立即拒绝，挂起的 `mutation` / `tool` 立即收到 `outcome_unknown` 且触发 `0` 次自动重试。
     4. _UI 与样式卸载零泄漏_：禁用插件或 `clientDigest` 变更时，活跃订阅被 `abort()`，注入的主题变量与 `<style>` 节点从 DOM 完整移除；`--safe-mode` 启动时跳过全部客户端插件与自定义样式。
2. **Phase 2（`headless` / `web` 跨机与 E2EE 分发）：** 接入 `MachineRpc` 与 [`e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts) 显式插件方法、`clientDigest` 保管域缓存与信任门控、`MachineSharing` 实时作用域校验及确认撤销擦除。
3. **明确延后项（在 Phase 1 真实运行时反馈前不纳入公开契约）：** 外部回环客户端 `createLodyClient()`、可移植角色蓝图 `manifest.agentRoles` / `roleTarget`、声明式表单生成器 `manifest.settings` / `usePluginSettings`（Phase 1 直接使用 `lody.settings.pages.add` 搭配插件自有 `defineQuery` / `defineMutation`）、`defineObservation` 与 `waitCondition` 跨插件唤醒、`machine.onSessionEvent`、自定义 `acpProviders` / `mcpServers` 捆绑分发、工作区级独立页 `workspace.pages.add` 以及全局悬浮窗/状态栏/快捷键注册表（`shell.*`、`commands.add`）。

## 核心保证与未决问题

- **诚实隔离与零隐式重试：** 单个插件子进程崩溃或死锁绝不波及主守护进程或其他已安装插件；副作用操作跨故障一律返回 `outcome_unknown`，宿主绝不背着调用方静默重放。
- **能力鉴权与离线诚实性：** 逻辑 `WorkspaceRef` 不绑定单机，绑定 `machineId` 的引用在机器离线时诚实返回 `machine_offline`；E2EE 下访客只读、项目级 `MachineSharing` 与签名 `e2eeIntent` 在每次调用时强制复核。
- **稳定 Token 与可控魔改分层：** `themes` CSS 变量构成跨版本稳定外观契约，托管 `styles` 提供本地可卸载深度定制能力并通过 `lody --safe-mode` 兜底恢复。
- **未决问题：** 原生移动端（`apps/mobile`）不执行 React `client.js` 产物，后续是否原生消费 `manifest.themes` 种子色板及指定结构化工具卡片留待桌面端 Phase 1 落地后评估。

## 证据路径

预期行为：本文档、[插件架构收敛与 E2EE 工作区边界](../.agents/notes/proposed/architecture/2026-11-22-plugin-architecture-and-e2ee-boundaries.zh.md)，以及 [`scripts/fixtures/plugin-sdk/sdk/`](../scripts/fixtures/plugin-sdk/sdk/shared.d.ts) 下的公开类型契约（[`client.d.ts`](../scripts/fixtures/plugin-sdk/sdk/client.d.ts)、[`machine.d.ts`](../scripts/fixtures/plugin-sdk/sdk/machine.d.ts)、[`manifest.d.ts`](../scripts/fixtures/plugin-sdk/sdk/manifest.d.ts)）。

已核查实现：[`packages/ui/src/index.ts`](../packages/ui/src/index.ts)、[`packages/components/src/components/loro-app-sidebar.tsx`](../packages/components/src/components/loro-app-sidebar.tsx)、[`packages/components/src/components/sidebar-surface.ts`](../packages/components/src/components/sidebar-surface.ts)、[`packages/components/src/hooks/use-permission-response.ts`](../packages/components/src/hooks/use-permission-response.ts)、[`packages/components/src/lib/vscode-theme/vscode-theme-dom.ts`](../packages/components/src/lib/vscode-theme/vscode-theme-dom.ts)、[`packages/components/src/lib/vscode-theme/vscode-theme-css.ts`](../packages/components/src/lib/vscode-theme/vscode-theme-css.ts)、[`packages/components/src/providers/workspace-machine-rpc-facade.ts`](../packages/components/src/providers/workspace-machine-rpc-facade.ts)、[`packages/shared/src/schema.ts`](../packages/shared/src/schema.ts)、[`packages/shared/src/acp/ask-user-question.ts`](../packages/shared/src/acp/ask-user-question.ts)、[`packages/shared/src/acp/history-apply.ts`](../packages/shared/src/acp/history-apply.ts)、[`packages/shared/src/acp/tool-call-history.ts`](../packages/shared/src/acp/tool-call-history.ts)、[`packages/shared/src/e2ee-rpc.ts`](../packages/shared/src/e2ee-rpc.ts)、[`packages/shared/src/e2ee-execution-intent.ts`](../packages/shared/src/e2ee-execution-intent.ts)、[`packages/platform/AGENTS.md`](../packages/platform/AGENTS.md)、[`packages/e2ee-machine-sharing/AGENTS.md`](../packages/e2ee-machine-sharing/AGENTS.md)、[`apps/cli/src/lib/e2ee/AGENTS.md`](../apps/cli/src/lib/e2ee/AGENTS.md)、[`apps/cli/src/mcp/AGENTS.md`](../apps/cli/src/mcp/AGENTS.md) 与 [`.agents/docs/failure-containment.md`](../.agents/docs/failure-containment.md)。

验证范围：[`scripts/plugin-sdk-contracts.test.mjs`](../scripts/plugin-sdk-contracts.test.mjs) 在纯浏览器（[`tsconfig.json`](../scripts/fixtures/plugin-sdk/tsconfig.json)，无 Node 类型）与纯守护进程（[`tsconfig.machine.json`](../scripts/fixtures/plugin-sdk/tsconfig.machine.json)，无 DOM 全局对象）两套隔离 TypeScript 配置下校验精简后的 SDK 声明、四个参考插件（[`test-report`](../scripts/fixtures/plugin-sdk/examples/test-report/client.tsx)、[`issue-context`](../scripts/fixtures/plugin-sdk/examples/issue-context/machine.ts)、[`worktrees`](../scripts/fixtures/plugin-sdk/examples/worktrees/client.tsx)、[`focus-sidebar`](../scripts/fixtures/plugin-sdk/examples/focus-sidebar/client.tsx)）及反向类型断言（[`contracts.ts`](../scripts/fixtures/plugin-sdk/contracts.ts)、[`machine-contracts.ts`](../scripts/fixtures/plugin-sdk/machine-contracts.ts)），并对 `issue-context` 的 `ctx.dataDir` 原子文件持久化执行并发写入与读写故障注入测试。守护进程 `PluginHost`、前端 `ClientPluginHost`、子进程生命周期回收与 E2EE 运行时门控尚未实现。
