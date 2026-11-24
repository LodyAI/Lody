# 插件架构收敛与 E2EE 工作区边界

Status: proposed
Translation: current

[English](2026-11-22-plugin-architecture-and-e2ee-boundaries.md)

## 摘要

围绕 [Lody 插件系统规范](../../../../specs/plugin-system.zh.md) 从运行时故障隔离、Agent Workspace 产品可塑性与 E2EE 授权边界三个维度收敛为**“极简故障即停的单插件独立子进程运行时（`child_process.fork`、Drain-Before-Respawn、零自动重试、`clientDigest` + `instanceId`、带 `contextId` 的 `host_call`）+ 零 Fork 可塑性 Agent Workspace 扩展契约”**：

- **工作区级与机器级客户端归属分离及多机去重**（纯前端插件按工作区单实例挂载且不受单机休眠影响；多机同名配套插件对工作区级 UI 贡献去重）；
- **规范化客户端/机器侧宿主事件（含本地单调游标续传）+ 长驻 `machine.service`**，叠加 **Command Palette、Slash Commands、客户端签名前 `composer.beforeSend`、`lody.ui` 基础反馈原语及 Session/Message/StatusBar 轻量槽位**；
- **通用 `tools.matchRender`（`replace` + 可叠加 `enhance`）与 `messages.renderBlock`**，强制保留宿主“查看原始输出”逃生开关与 `@layer lody-plugin` 样式层隔离；
- **双层读取模型与宿主托管存储**：Tier-1 归一化 `lodyQueries` + 跨端同步 `annotations` + 托管作用域原子 `storage`，配合显式 Opt-in 的 Tier-2 **`lody.unstable.readSnapshot` / `useUnstableLodySnapshot` 白名单投影、必填切片、`<= 512 KiB` 逃生舱**，既保住重度客制化不撞墙，又不锁死 Loro/Roost 内部 schema 或埋下黑名单漏脱敏隐患；
- **显式 `manifest.permissions`（`sessions.write`、`sessions.approve`、`workflow.autonomous`、`unstable.rawState`）与双模型 E2EE 授权**：将活跃回合内 `SignedTurnOrigin` 派生（`ToolExecutionContext`）与机主签发 `DeclaredWorkflowGrant`（回合后事件、重启恢复与后台桥接）彻底分离。

## 核心收敛决策

### 1. 保持运行时底座极简：每插件独立子进程、Drain-Before-Respawn 与故障即停

对齐 [`.agents/docs/failure-containment.md`](../../../../.agents/docs/failure-containment.md) 与 Paseo 外部子进程边界：

- **每个已启用的 `machine` 插件独占一个 `child_process.fork` 子进程**（纯前端、音效、主题或纯 Skill 插件为 `0` 个后端进程）：任何崩溃、死循环或 V8 OOM 天然归因到唯一 `pluginId`，彻底淘汰 Canary 归因 Worker。
- **Drain-Before-Respawn 与串行生命周期队列：** 同一 `pluginId` 的 `enable` / `reload` / `disable` / `remove` 严格经单队列串行执行；停止遵循 `shutdown → 2s SIGTERM → 2s SIGKILL`，且**在旧 OS PID 发出 `close` 前绝不派生替代进程**，杜绝 `ctx.dataDir` 并发写损坏。
- **有界空闲回收 `--dev` 编译子进程与 `clientDigest` + `instanceId`：** 开发态 `esbuild` 在按需子进程中运行、经有界空闲期（如默认 `30 s`）及守护进程退出时回收；`ClientPluginHost` 按 `clientDigest = SHA-256(client.js + assets/)` 幂等调和，`PluginHost` 按单调 `instanceId` 追踪运行代次。
- **单层扁平 IPC（带 `contextId` 的 `host_call`）与零自动重试：** 每次 `host_call` 携带 `contextId`（`callId` / `eventId` / `"start"` / `"service"`）并将所有宿主命令写操作收口至单一 `lody.execute` 线协议操作码。意外退出或超时将未完成 `mutation` / `tool` 结算为 `outcome_unknown`、`query` 直接报错，读写 `0` 自动重试，进入 `Faulted` 直至显式 `reload`。超出 `16 KiB`（`<= 2 MiB`）的 `defineTool` 输出由宿主自动溢出至托管回合产物存储，不再在执行完成后硬拒 `validation_failed`。

### 2. 分级保障 Agent Workspace 可塑性

- **规范化宿主事件（`lody.events.on` 与 `machine.events.on`）、游标续传与长驻 `machine.service`：** 补齐 `session.archived` 与 `session.interaction.resolved`；有界队列防止慢工具事件队头阻塞控制事件；本地 SQLite 事件游标（`resumeFromCursor: true`）+ 宿主托管原子 `ctx.storage` 消除 200 行手写文件锁与全历史扫描；`machine.service(ctx)` 突破 `30 s` `onStart` 时限，原生承载 Slack/Telegram/飞书审批桥接与 Webhook。
- **高频客户端扩展入口（`commands`、`composer.slashCommands`、签名前 `composer.beforeSend`、`lody.ui`、轻量槽位）：** 补齐命令面板、可执行 `/slash` 命令、个人设备签名前可见提示词钩子（保持 100% E2EE 完整性）、`toast`/`confirm`/`openExternalUrl`/`copyToClipboard` 以及会话顶栏/消息底部/状态栏槽位。
- **通用工具匹配渲染（`replace` + 可叠加 `enhance`）与消息块渲染：** `"replace"` 选出唯一胜出者（配宿主“查看原始输出”开关与 `SurfaceErrorBoundary`），`"enhance"` 可叠加挂载；`messages.renderBlock` 凭 `blockId = "<turnId>:block:<ordinal>"` 跨流式更新保态并遵守 [`ai-gui`](../../../../packages/components/src/components/ai-gui/AGENTS.md) 不变量。
- **双层工作区数据与外观（`themes` / `@layer lody-plugin` `styles`；Tier-1 `lodyQueries` + `annotations` + `storage` / Tier-2 `lody.unstable.readSnapshot`）：** Tier-1 归一化查询、跨端同步 `<= 4 KiB` 实体 `annotations` 与宿主托管 `storage` 覆盖主流插件；Tier-2 `lody.unstable.readSnapshot` / `useUnstableLodySnapshot` 在显式 `unstable.rawState` 权限、白名单域投影（非黑名单裸树导出）、强制路径/窗口切片与 `512 KiB` 硬上限下为重度客制化保留无围墙兜底。
- **完整工作流组合（`agentRoles`、`skills`、`mcpServers`、条件托管 `acpProviders`）：** Core 包含 Roles、Skills 与进程外 `stdio` MCP（[`apps/cli/src/agent/AGENTS.md`](../../../../apps/cli/src/agent/AGENTS.md)）；`acpProviders` 声明式桥接至既有托管 ACP 扩展契约（`LodyAI/acp-extension-core` 与 `acp-session-start-gate.ts`），不另造纯 Node 启动器。

### 3. 包来源归属（`npm` vs `local`）、Web 优先页面与设置、DX 与提议-确认 UX

- **钉死版本 `npm` vs `local` 归属、机主自有机器同步与多机动态路由：** 公开发布的 `npm` 包（精确版本 + SRI `integrity` + `clientDigest` 存于加密 `WorkspacePluginEntry`）使 Web 在 `0` 机器在线时即可通过 CORS `.tgz` 冷启动（获批前零外网请求，防火墙或私有源下回退至 `plugin/bundle-chunk`），并支持仅限安装者自有机器的 `machineSync: "owner_machines"`（绝不跨成员自动安装、绝不复制 `secret` 或静默签发 `DeclaredWorkflowGrant`）。本地/开发/GitHub CLI 安装严格绑单机、永不自动同步。多机去重后的工作区主客户端实例按 `target.machineId` 动态转发 RPC 与导航，不再绑死单机。
- **路由化自定义页面与三层自定义设置：** `screens`（`/$workspaceName/p/$pluginId/$screenId` + `nav: "sidebar"`）、`project.pages`（项目路由）与 `session.panels`（同步 `?panel=` 的右侧 Split Pane）取代单一 `<Dialog>` 弹窗，并定义 5 态冷启动 URL 解析器（`resolving`、`untrusted`、`source_offline`、`disabled`/`not_installed`、`safe_mode`）。`settings.pages.add` 支持 `workspace`（`0` 机器在线可用）、`machine` 与 `project`（内嵌 Project Settings），配合宿主托管的 `<PluginSecretField />`（只写不读）、`<PluginConfigForm />` 与 `lody.settings.open(...)`；机主远程 `plugin/control`（含 `set-secret` 与 `resolve-proposal`）经 E2EE 授权向 Web/Mobile 开放，不再限本地通道。
- **声明式 `manifest.config`（含 `scope: "project"`）、`manifest.permissions` 与 `onboarding`：** 高权限操作（`sessions.write`、`sessions.approve`、`workflow.autonomous`、`unstable.rawState`）必须显式声明并披露；`sdk` 使用标准 SemVer 范围校验，并将易变侧边栏分流命令标为 shell-coupled / experimental。
- **Agent 辅助开发与 `lody_plugin` 提议-确认门禁：** 复用 [`schedules/AGENTS.md`](../../../../apps/cli/src/lib/schedules/AGENTS.md)（`schedule_proposal.ts`）与 `lody_agent_role` 范式，通过幂等聊天审批卡由人类最终确认（如实将 `LODY_AGENT_SESSION_ID` 定性为防误触协作护栏，而非针对 Shell Agent 的安全边界）。

## 端到端加密（E2EE）工作区安全边界

在 E2EE 工作区（[`specs/e2ee-foundations.md`](../../../../specs/e2ee-foundations.md)）中，插件执行五道架构边界：

1. **Guest（`read`）与非访客执行门禁：** 遵循 [`e2ee-rpc.ts`](../../../../packages/shared/src/e2ee-rpc.ts) 与 [E2EE 只读查询](../../implemented/architecture/2026-10-28-e2ee-read-queries.zh.md)，`plugin/query`、`plugin/mutate`、`plugin/control` 与 `plugin/attachment-*` 不进入 `E2EE_READ_QUERY_METHODS`，要求非 Guest `authorizeExecution`（`<15 min` 账本新鲜度）。
2. **机器所有者与按项目 `MachineSharing`：** 遵循 [`specs/e2ee/machine-sharing.zh.md`](../../../../specs/e2ee/machine-sharing.zh.md) 与 [`packages/e2ee-machine-sharing/AGENTS.md`](../../../../packages/e2ee-machine-sharing/AGENTS.md)，插件生命周期、远程 `plugin/control`（`enable`/`disable`/`reload`/`set-secret`/`resolve-proposal`/`manage-workflow-grant`）、`owner_machines` 同步范围、`DeclaredWorkflowGrant` 签发与撤销、`machine` 级密钥/调用与 Workflow Provider 配置仅限机器所有者；协作者仅在 `MachineSharing` 授权该机器及全部绑定项目时可调用 `'project'` / `'session'` 处理器并写入非敏感 `scope: "project"` 配置。
3. **双模型签名执行意图（活跃回合派生 vs 机主签发工作流授权）：** 遵循 [`e2ee-execution-intent.ts`](../../../../packages/shared/src/e2ee-execution-intent.ts)、[签名执行意图](../../implemented/architecture/2026-11-10-e2ee-signed-execution-intent.zh.md) 与 [共享成员派生](../../implemented/architecture/2026-10-31-e2ee-shared-member-derivation.zh.md)：
   - 客户端交互写入（`create` / `send` / `respondInteraction`，在客户端 `composer.beforeSend` 之后）与机主远程 `plugin/control` 写操作签发 `memberInput`（`kind = 1`）。
   - **模型 A（回合内派生）：** 守护进程 `ToolExecutionContext` 核验驱动回合在运行时仍活跃且匹配本地 `sessionData` 中人类签名的 `originTurn`，签发 `derivedFrom` `machineInput`（`kind = 2`，20 跳上限，限同机）；回合结束后历史记录不再授权新成员派生。
   - **模型 B（工作流授权）：** 回合外守护进程上下文（`session.turn.completed`、`onStart` 恢复、`machine.service` 桥接）要求具备 `manifest.permissions`（`workflow.autonomous` + `sessions.write` / `sessions.approve`）及经核验、未撤销的机主签名 `DeclaredWorkflowGrant`（限定 `workspace_id`、`machine_id`、`plugin_id`、`op`、`project`、`role`），以工作流主体执行并拒绝个人 `prefer` 写操作。无根 `query`/`mutation`/`attachmentSource` 拒绝会话写入（`forbidden`）。
4. **256 KiB 单帧 Iroh 快路径、钉死 `npm` Web 冷启动与 Core 4 MiB 分页产物：** 遵循 [E2EE Iroh 传输](../../implemented/architecture/2026-11-10-e2ee-iroh-transport.zh.md)，`MAX_PLUGIN_RPC_REQUEST_BYTES`（`256 KiB`）装入单个 1 MiB `purpose 8` 帧，`MAX_PACKED_CLIENT_BUNDLE_BYTES`（`4 MiB`）复用 `256 KiB` `purpose 9` 分页读取；钉死 `npm` `.tgz` 仅在用户批准后拉取（元数据来自加密 `WorkspacePluginEntry`），并在落盘或 `import()` 前核验 SRI `integrity` + `clientDigest` SHA-256。
5. **托管隔离、白名单投影与明文分享兜底：** 守护进程 `ctx.dataDir`、`ctx.storage`、`SessionCreationReceipt`、`DeclaredWorkflowGrant`、本地事件游标表与 Core Web/Desktop 远程产物与信任 IndexedDB 缓存（含跨标签页 `BroadcastChannel`）绑定至 `<account>/<workspace>/<genesis>/<signing-key>`（[`apps/cli/src/lib/e2ee/AGENTS.md`](../../../../apps/cli/src/lib/e2ee/AGENTS.md)、[`specs/e2ee/client-custody.zh.md`](../../../../specs/e2ee/client-custody.zh.md)、[`specs/e2ee/desktop-custody.zh.md`](../../../../specs/e2ee/desktop-custody.zh.md)），成员移除或设备吊销时原子擦除；Tier-2 快照采用白名单域投影；静态明文分享（[明文分享授权](../../implemented/feature/2026-10-28-e2ee-share-plaintext-consent.zh.md)）仅渲染内置兜底卡片，不上传 `ctx.dataDir` 且不执行第三方 `client.js`。

## 被否决的替代方案

1. **单机共享 `PluginWorker` + Canary 归因 + 静默只读重试：** 因故障连坐与不确定副作用被否决，改用 OS 子进程物理隔离与确定性故障即停。
2. **将回合后/重启恢复工作流强塞进活跃回合 `SignedTurnOrigin` 派生：** 回合结束后按定义已非活跃；改为与回合内 `ToolExecutionContext` 派生正交的机主签名 `DeclaredWorkflowGrant`。
3. **将纯前端 UX 插件强绑在单机守护进程或按机重复挂载多份实例：** 导致单机休眠掉体验、多机重影双倍音效；改为钉死 `npm` 工作区源（`local` 严守单机）+ 多机去重后的动态 RPC 路由。
4. **将 GitHub Release 原始下载链接作为 Web 冷启动主源：** 因 `objects.githubusercontent.com` 重定向缺少浏览器 CORS 头而被否决；仅保留作单机 CLI 安装源，跨端 Web 冷启动与 `owner_machines` 同步统一采用钉死版本 `npm` `.tgz`。
5. **将 `screens`、`project.pages`、`session.panels` 统统塞进全局 `<Dialog>`，或向自定义设置 JS 暴露明文密钥：** 破坏 Web 路由/分栏体验并威胁密钥托管；改为路由化主工作区/分栏面板，以及 `workspace | machine | project` 三层设置 + 只写不读 `<PluginSecretField />`。
6. **在 Tier-1 Core 中以黑名单脱敏直接裸吐内部 CRDT 树：** 会锁死 Loro/Roost 内部 schema 并在新增内部敏感字段时静默泄露；改为 Tier-1 归一化查询/`annotations` + 显式 Opt-in 的 Tier-2 白名单切片 `lody.unstable.readSnapshot`。
7. **逼迫每个工作流插件在 `30 s` `onStart` 超时下自己手写原子文件锁与全历史扫描：** 改为宿主托管原子 `storage` 与本地 SQLite 事件游标续传（`resumeFromCursor`）。
8. **`machine.beforeSessionTurn` 签名后静默改写提示词，或把 `LODY_AGENT_SESSION_ID` 当作安全边界：** 签名后篡改破坏 E2EE 完整性（改由客户端签名前 `composer.beforeSend` 承接），而环境变量对具备 Shell 能力的 Agent 只是协作护栏。

## 影响与验证状态

- [`scripts/plugin-sdk-contracts.test.mjs`](../../../../scripts/plugin-sdk-contracts.test.mjs) 与 [`scripts/plugin-dev-acceptance.py`](../../../../scripts/plugin-dev-acceptance.py) 验证了 PR-1/PR-2 基础 SDK 契约、子进程隔离与本地 CLI 循环。
- 修订后契约（`manifest.permissions`、带 `contextId` 的 `host_call`、`storage`、事件游标、`machine.service`、工作区/机器去重、`commands`/`slashCommands`/`beforeSend`、Tier-2 白名单快照、宿主工具输出自动溢出、`DeclaredWorkflowGrant` 与 `lody_plugin` 审批卡）的工程对齐追踪见 [插件系统实施设计与分层 PR 落地计划](2026-11-23-plugin-system-implementation-design.zh.md) 与 [规范 §17.4](../../../../specs/plugin-system.zh.md#174-仓库证据与当前实现状态repository-evidence--current-implementation-status)。
