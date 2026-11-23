# 插件架构收敛与 E2EE 工作区边界

Status: proposed
Translation: current

[English](2026-11-22-plugin-architecture-and-e2ee-boundaries.md)

## 摘要

围绕 [Lody 插件系统规范](../../../../specs/plugin-system.zh.md) 同时从运行时故障隔离（对标 Paseo 生产插件宿主）与 Agent Workspace 产品可塑性两个维度进行审视后，暴露出两类正交问题：（1）单机共享 `PluginWorker` 制造了级联运行时复杂度（跨插件连坐崩溃、Canary 故障复现 Worker、静默只读重试与三摘要协同）；（2）在收缩运行时复杂度的同时若过度砍削扩展面，会把 Lody 退化为仅有固定 React 槽位与 RPC 的传统插件系统，无法自然表达音效插件（Sound Effects）、跨工具结果渲染替换、Sorbet 级完整 Workflow 插件、全自由度工作区监控面板、Agent 辅助创建安装插件以及 Desktop + Web 一致的跨端体验。本文收敛为**“极简故障即停的单插件独立子进程运行时（`child_process.fork`、Drain-Before-Respawn、零自动重试、`clientDigest` + `instanceId`）+ 零 Fork 可塑性 Agent Workspace 扩展契约”**：统一客户端/机器侧宿主事件总线、带强制“查看原始输出”逃生开关的通用 `tools.matchRender` 与 `messages.renderBlock` 渲染器、完整 Workflow 组合（`agentRoles`、`skills`、进程外 `mcpServers` 与 `acpProviders`）、扩展类型化 `lodyQueries` 加深度只读原始文档快照（`useLodySnapshot` / `readSnapshot`）、声明式 `manifest.config` 与首次引导 `onboarding`、基于 `lody_plugin` `propose_*` 人类确认卡片的 Agent 辅助插件工作流、纳入 `Core Conformance` 的 Electron + Web 统一 Bundle 流式分发（配合 Mobile Capacitor 内联卡片/声明式配置与 `useHostCapabilities()` 能力协商），以及五道 E2EE 签名与托管安全边界。

## 核心收敛决策

### 1. 保持运行时底座极简：每插件独立子进程、Drain-Before-Respawn 与故障即停

对齐 [`.agents/docs/failure-containment.md`](../../../../.agents/docs/failure-containment.md) 与 Paseo 外部子进程边界：

- **每个已启用的 `machine` 插件独占一个 `child_process.fork` 子进程**（纯前端、音效、主题或纯 Skill 插件为 `0` 个后端进程）：任何崩溃、死循环或 V8 OOM 天然归因到唯一 `pluginId`，彻底淘汰 Canary 归因 Worker。
- **Drain-Before-Respawn 与串行生命周期队列：** 同一 `pluginId` 的 `enable` / `reload` / `disable` / `remove` 严格经单队列串行执行；停止遵循 `shutdown → 2s SIGTERM → 2s SIGKILL`，且**在旧 OS PID 发出 `close` 前绝不派生替代进程**，杜绝 `ctx.dataDir` 并发写损坏。
- **`1s` 空闲回收 `--dev` 编译子进程与 `clientDigest` + `instanceId`：** 开发态 `esbuild` 在按需子进程中运行、空闲 `1s` 即退出；`ClientPluginHost` 仅按 `clientDigest = SHA-256(client.js + assets/)` 幂等调和，`PluginHost` 按单调 `instanceId` 追踪运行代次，移除 `machineDigest` 与 `revision_mismatch`。
- **单层扁平 IPC 与零自动重试：** 意外退出或超时将未完成的 `mutation` / `tool` 结算为 `outcome_unknown`、`query` 直接报错，读写均 `0` 次自动重试，插件进入 `Faulted` 直至用户显式 `reload`。

### 2. 在不膨胀运行时的前提下完整恢复 Agent Workspace 可塑性

简化进程生命周期绝不等于阉割平台扩展能力：

- **规范化宿主事件总线（`lody.events.on` 与 `machine.events.on`）+ 正交静态资源与生命周期原语（`lody.assets.url`、`lody.signal`）：** 插件可直接订阅类型化 Session/Turn/Tool 状态跃迁及本地 UI 交互事件（`ui.message.submitted`、`ui.session.switched`、`ui.interaction.resolved`、`ui.command.invoked`），直接组合标准 Web Audio + `assets.url` + `signal` 实现零后端进程的音效插件而不在 SDK 中制造非原语 `audio` 槽位与事件驱动编排器（配合 `machine.onStart(ctx)` 结合 `ctx.dataDir` 日志与 `lodyQueries.sessions` `updatedAfter` + `sessionTurns` 增量对账，无需引入 Durable Event Broker 即可在守护进程重启后恢复中途崩溃与停机错过的回合事件，并完整保留 `ProjectRef`、`parentSession` 与 E2EE `originTurn`）。
- **通用工具调用匹配渲染与结构化消息块渲染：** 在自有工具 `tools.render` 之外，新增 `tools.matchRender` 支持按工具名、MCP 服务、`acpKinds`、命令正则或谓词匹配内置/Claude/Codex/Antigravity/MCP 工具并按确定性优先级接管展示；新增 `messages.renderBlock` 渲染自定义 fenced 代码块/结构化产物，并通过确定性 `blockId = "<turnId>:block:<ordinal>"` 在流式增量更新与围栏闭合全程保持组件挂载实例与内部交互状态。宿主在卡片头部强制保留不可伪造的“查看原始输出 / 原始 Markdown”切换开关与 `SurfaceErrorBoundary`，确保绝不遮蔽真实输出或破坏 [`ai-gui`](../../../../packages/components/src/components/ai-gui/AGENTS.md) 搜索与折叠不变量。
- **完整 Workflow 插件组合（`agentRoles`、`skills`、`mcpServers`、`acpProviders`）：** 支持像 Sorbet Super Assistant 一样在同一插件包中交付 Roles、Skills、守护进程外标准 MCP 服务（[`apps/cli/src/agent/AGENTS.md`](../../../../apps/cli/src/agent/AGENTS.md)）以及自定义 ACP Agent 运行时（`Workflow Provider Conformance Profile`，经 `acp-session-start-gate.ts` 受控拉起）。
- **扩展类型化 `lodyQueries` + 脱离底层句柄的只读原始状态快照（`useLodySnapshot` / `readSnapshot`）：** 在 18 个类型化查询（含 `sessionTurns`、`subagentRun`、`agentConfigs`、`automations`、`plugins`）之外，直接复用现有 Loro/Flock 与 [`session-data`](../../../../packages/shared/src/session-data/AGENTS.md) / Roost 读取及增量订阅基础设施，按需懒物化授权范围内的深度冻结（`Object.freeze`）脱敏只读快照（零平行 Domain Store、不在每次提交或流式 Token 时重建整棵状态树），同时保持 `HistoryWriter` 与内核命令作为唯一写入口。
- **双层外观体系（`themes` + 宿主托管 `styles`）与三层正交侧边栏：** 保留 SemVer 稳定的 `--*` 主题令牌（[`vscode-theme-dom.ts`](../../../../packages/components/src/lib/vscode-theme/vscode-theme-dom.ts)、[`vscode-theme-css.ts`](../../../../packages/components/src/lib/vscode-theme/vscode-theme-css.ts)）、可销毁 `<style>` 注入与三层侧边栏组合（[`sidebar-surface.ts`](../../../../packages/components/src/components/sidebar-surface.ts)）。

### 3. 一等公民的 DX、UX、Agent 提议-人类确认工作流与跨端 Core 一致性

- **Electron + Web 同属 `Core Conformance`，Mobile Capacitor 渐进协商：** 远程 `client.js` 分页流式加载（`<= 4 MiB` + 发布态逐 `clientDigest` 信任门禁，配合 `--dev` 模式下显式开启、绑定 `(workspace_id, machine_id, plugin_id, devSessionNonce)` 且可随时撤销的 **Trusted Dev Session** 免弹窗 Web 热更新）升格为 `Core Conformance`，保证 Web 与桌面端体验完全一致；[`apps/mobile-capacitor`](../../../../apps/mobile-capacitor/AGENTS.md) 在 Core 中原生支持工具/消息内联卡片、客户端事件与声明式配置，并通过 `useHostCapabilities()` 协商与注册表 1:1 对齐的外壳 `containers`（`sidebarViews`、`sessionPanels`、`screens`、`projectPages`）。
- **声明式 `manifest.config` + `onboarding`：** 自动生成原生插件设置表单与首次启用配置引导抽屉，免除手写设置面板负担，且 `secret` 字段仅落盘守护进程系统钥匙串。
- **Agent 辅助开发与 `lody_plugin` 提议-确认门禁：** 复用 [`schedules/AGENTS.md`](../../../../apps/cli/src/lib/schedules/AGENTS.md)（`schedule_proposal.ts`）与 `lody_agent_role` 的成熟范式，Agent 可脚手架生成插件并通过 `propose_install` / `propose_enable` / `propose_reload` 发送幂等聊天审批卡片，可执行代码的启用始终必须经人类点击确认（人类终端清除 `LODY_AGENT_SESSION_ID`）。

## 端到端加密（E2EE）工作区安全边界

在 E2EE 工作区（[`specs/e2ee-foundations.md`](../../../../specs/e2ee-foundations.md)）中，插件执行五道架构边界：

1. **Guest（`read`）与非访客执行门禁：** 遵循 [`e2ee-rpc.ts`](../../../../packages/shared/src/e2ee-rpc.ts) 与 [E2EE 只读查询](../../implemented/architecture/2026-10-28-e2ee-read-queries.zh.md)，`plugin/query`、`plugin/mutate` 与 `plugin/attachment-*` 不进入 `E2EE_READ_QUERY_METHODS`，要求非 Guest `authorizeExecution`（`<15 min` 账本新鲜度）。
2. **机器所有者与按项目 `MachineSharing`：** 遵循 [`specs/e2ee/machine-sharing.zh.md`](../../../../specs/e2ee/machine-sharing.zh.md) 与 [`packages/e2ee-machine-sharing/AGENTS.md`](../../../../packages/e2ee-machine-sharing/AGENTS.md)，插件生命周期、`machine` 级密钥/调用与 Workflow Provider 配置仅限机器所有者；协作者仅在 `MachineSharing` 授权该机器及全部绑定项目时可调用 `'project'` / `'session'` 处理器。
3. **跨客户端交互、工具与有根 Workflow 事件的 `e2eeIntent` 签名：** 遵循 [`e2ee-execution-intent.ts`](../../../../packages/shared/src/e2ee-execution-intent.ts)、[签名执行意图](../../implemented/architecture/2026-11-10-e2ee-signed-execution-intent.zh.md) 与 [共享成员派生](../../implemented/architecture/2026-10-31-e2ee-shared-member-derivation.zh.md)，客户端（`create` / `send` / `respondInteraction`）签发 `memberInput`（`kind = 1`），机器侧有根上下文对称支持 `create` / `send` / `respondInteraction`；守护进程 `ToolExecutionContext`、`MachineEventContext` 与 `MachineStartupContext` 凭经本地 `sessionData` 核验的人类签名根回合 `SignedTurnOrigin`（`originTurn: { session, userTurnId }`，或本机所有者签名工作流声明）签发 `derivedFrom` `machineInput`（`kind = 2`，继承 20 跳上限与单机规则），无根查询/写操作拒绝 `create` / `send` / `respondInteraction`（`forbidden`）。
4. **256 KiB 单帧 Iroh 快路径与 Core 4 MiB 分页 Web 产物：** 遵循 [E2EE Iroh 传输](../../implemented/architecture/2026-11-10-e2ee-iroh-transport.zh.md)，`MAX_PLUGIN_RPC_REQUEST_BYTES`（`256 KiB`）装入单个 1 MiB `purpose 8` 帧，`MAX_PACKED_CLIENT_BUNDLE_BYTES`（`4 MiB`）复用 `256 KiB` `purpose 9` 分页读取。
5. **托管隔离、快照脱敏与明文分享兜底：** 守护进程 `ctx.dataDir` 与 Core Web/Desktop 远程产物缓存绑定至 `<account>/<workspace>/<genesis>/<signing-key>`（[`apps/cli/src/lib/e2ee/AGENTS.md`](../../../../apps/cli/src/lib/e2ee/AGENTS.md)、[`specs/e2ee/client-custody.zh.md`](../../../../specs/e2ee/client-custody.zh.md)、[`specs/e2ee/desktop-custody.zh.md`](../../../../specs/e2ee/desktop-custody.zh.md)），成员移除或设备吊销时原子擦除；原始快照剥离密钥与外部插件私有 `businessKey`；静态明文分享（[明文分享授权](../../implemented/feature/2026-10-28-e2ee-share-plaintext-consent.zh.md)）仅渲染内置兜底卡片，不上传 `ctx.dataDir` 且不执行第三方 `client.js`。

## 被否决的替代方案

1. **单机共享 `PluginWorker` + Canary 归因 + 静默只读重试：** 因故障连坐与不确定副作用被否决，改用 OS 子进程物理隔离与确定性故障即停。
2. **仅允许渲染自有 Tool 或砍掉宿主事件与 Workflow Roles/Providers：** 会迫使音效等交互插件走 DOM 注入/轮询，并堵死 Sorbet 等零 Fork 工作流扩展。
3. **将 Web 远程插件 UI 降级为可选扩展或一刀切禁止 Agent 插件提议：** Web 是 Lody 核心端面，`propose_*` + 人类确认卡片既守住人类对代码执行的最终授权，又保留了 Agent 辅助造插件的一流体验。
4. **`machine.beforeSessionTurn` 静默改写提示词或暴露可变 CRDT 句柄：** 签名后篡改提示词破坏 E2EE `memberInput` 完整性；深度冻结只读快照在不绕过 `HistoryWriter` 的前提下释放了全部读取自由度。

## 影响与验证状态

- [`scripts/plugin-sdk-contracts.test.mjs`](../../../../scripts/plugin-sdk-contracts.test.mjs) 已在纯浏览器与纯 Node 双 `tsconfig` 下验证 [`sdk/shared.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)、[`sdk/client.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/client.d.ts)、[`sdk/machine.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/machine.d.ts)、[`sdk/manifest.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/manifest.d.ts)、正反向契约断言（[`contracts.ts`](../../../../scripts/fixtures/plugin-sdk/contracts.ts)、[`machine-contracts.ts`](../../../../scripts/fixtures/plugin-sdk/machine-contracts.ts)）以及六个参考插件（`test-report`、`issue-context`、`worktrees`、`focus-sidebar`、`sound-effects`、`sorbet-workflow`），并覆盖 `ctx.dataDir` 并发故障注入、`sound-effects` 事件清理与 `sorbet-workflow` 原始快照事件编排及 `machine.onStart` 守护进程重启恢复运行时测试。
- 生产级运行时宿主（`PluginHost`、`ClientPluginHost`、`lody_plugin` 审批卡片、声明式配置表单与 E2EE 运行时门禁）尚待第一阶段按规范实施。
