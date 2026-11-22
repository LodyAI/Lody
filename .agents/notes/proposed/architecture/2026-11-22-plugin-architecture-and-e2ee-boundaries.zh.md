# 插件架构收敛与 E2EE 工作区边界

Status: proposed
Translation: current

[English](2026-11-22-plugin-architecture-and-e2ee-boundaries.md)

## 摘要

对照 Paseo 真实插件运行时对 [Lody 插件系统规范](../../../../specs/plugin-system.zh.md) 初版设计进行对抗性审查表明：初版为追求「单机器共享 `PluginWorker`」省内存前提，自我制造了跨插件连坐崩溃、金丝雀（Canary）故障复现、只读自动重试及三哈希（`clientDigest` / `machineDigest` / `revision`）等连环复杂度，同时在真实运行时落地前过早堆叠了外设回环服务与多 Agent 蓝图等外围契约。本记录提议收敛为**每启用 `machine` 插件独立子进程 + 串行排空回收（`shutdown → 2s SIGTERM → 2s SIGKILL`）+ Fail-Stop（零自动重试）+ `clientDigest` 与运行时 `instanceId`** 的最小完备运行时，保留原始响应式数据 SDK（`lodyQueries`）、三层正交侧边栏、类 Obsidian 双层主题与托管自定义 CSS（稳定 `--*` 变量契约 + 本地可卸载 `styles`）以及六项 E2EE 安全硬边界。该方案以每个已启用后端插件约 `30–45 MiB` 独立子进程开销换取天然的 OS 级故障归因与确定性回收，同时要求 E2EE 访客禁用动态插件查询并将 `'machine'` 作用域限定于机器拥有者本人。当前仅 TypeScript SDK 类型契约与 `ctx.dataDir` 原子持久化夹具完成校验，守护进程与前端运行时宿主及真实子进程/浏览器 E2E 测试尚待实现。

## 对抗性审查核心收敛决策

### 1. 推翻「单机共享 `PluginWorker` + 金丝雀归因 + 只读自动重试」，改为每插件独立子进程 + Fail-Stop

初版设计假设整机共用单个 `PluginWorker` 以节省常驻内存，但一旦任一插件触发同步死循环或 V8 OOM，同进程全部插件将连坐中断且无可靠异常栈归属；初版为此层层打补丁，引入了隔离金丝雀进程二次复现、在途 `defineQuery` 静默重试与 Automation 连续错误豁免。参照 [`.agents/docs/failure-containment.md`](../../../../.agents/docs/failure-containment.md) 与 Paseo 的外部插件进程模型：

- **每启用 `machine` 插件独占一个 `child_process.fork` 子进程**（纯前端/主题/Skill 插件占 `0` 个后端进程）：崩溃或死锁天然归属于唯一 `pluginId`，彻底删除金丝雀复现机制。
- **Drain-Before-Respawn 与单队列生命周期：** 每个 `pluginId` 的启停与重载串行排队；停止旧进程严格执行 `shutdown` → `2s SIGTERM` → `2s SIGKILL`（等待退出期间不提前调用 `child.disconnect()` 以保证 `close` 事件必达），**旧进程彻底退出前绝不拉起替代进程**，从根源消除新旧进程并发写坏 `ctx.dataDir`。
- **独立空闲退出的 `--dev` 编译子进程：** 开发态 `esbuild` 放入空闲 `1s` 自动退出的独立短生命周期子进程，既不污染守护进程常驻堆，也不在宿主退出时残留僵尸编译器。
- **单层扁平 IPC 与 Fail-Stop（零隐式重试）：** 宿主与子进程直接使用单层扁平 IPC 消息通信；子进程异常退出或超时后立即拒绝在途调用（`defineMutation` / `defineTool` 报 `outcome_unknown`，`defineQuery` 直接报错，读写均 `0` 次自动重试）并置为 `plugin_faulted` 直至用户显式 `reload`。

_刻意不照搬 Paseo 的两点设计：_（1）不引入 Paseo 的进程内 `InternalPluginChild` 特权路径，内置迁移插件与第三方插件统一走相同子进程契约，避免内置插件崩溃拖垮主守护进程；（2）不在 Node IPC 之上像 Paseo 那样再套一层双端 WebSocket RPC 隧道，保持单层消息可观测与零协议冗余。

### 2. 用 `clientDigest` + 运行时 `instanceId` 取代三哈希与 `revision_mismatch`

初版为解决「前端改一行样式导致整包 `revision` 变化并打断正在执行的 Agent Turn」，在 `revision` 与 `clientDigest` 之外发明了第三套 `machineDigest`。拆解前后端真实耦合点后可直接化简：

- 前端仅关心 `clientDigest = SHA-256(client.js + assets/)`：`--dev` 重建若未改变 `clientDigest`，前端保留当前插件挂载实例、`AbortController` 与查询缓存；变化时先清理旧订阅与托管 `<style>` 再切换新实例。
- 后端每次启动 `machine` 子进程仅生成单调运行时 `instanceId`：修改 `client.tsx`、主题或 `skills/` 根本不重启 `machine` 子进程，在途 Agent Turn 天然不受干扰；前后端契约校验交由两侧各自的 Zod `safeParse` 兜底，删除脆弱的整包 `revision_mismatch` 拒绝码。

### 3. 保留原始数据 SDK、三层正交侧边栏与类 Obsidian 双层主题/CSS 体系

- **极薄组件入参与三层正交侧边栏：** 组件仅接收能力引用与路由 `params`，通过 `lodyQueries` + `useLodyQuery` 按需读取 [`SessionMeta`](../../../../packages/shared/src/schema.ts)（含 `openedBySessionId`、`openedByRootSessionId`、`agentRoleId`、`pendingInteraction`）及机器/Git 状态。侧边栏基于 [`sidebar-surface.ts`](../../../../packages/components/src/components/sidebar-surface.ts) 拆分为 `sidebar.sessionRow.decorate`（配合 `lody.sessions.answerQuestion` 与 [`ask-user-question.ts`](../../../../packages/shared/src/acp/ask-user-question.ts) / [`use-permission-response.ts`](../../../../packages/components/src/hooks/use-permission-response.ts) 原地回答后台追问，工具 `permission` 仍由内核独占）、`headerItems`/`footerItems` + `<SidebarRow />` + `screens.add` 与可切换 `sidebar.views.add`（`<SessionRow />` 自动组合行装饰器）。
- **为什么保留 `themes` + 托管 `styles` 双层外观而非一刀切砍掉 CSS：** 在用户主动信任且非沙箱的前端插件模型下，`client.js` 本就运行于主线程并可直改 `document`，删掉 `styles` 并不能形成安全沙箱，只会逼迫插件私自 `document.head.appendChild` 留下无法随禁用清理的泄漏样式。真正需要划分的是**契约稳定性边界**：第一层 `manifest.themes` / `lody.themes.add` / `activate`（含 `PluginThemeSeedColors` 与字体/圆角/`density` `PluginThemeTokens`）经 [`vscode-theme-dom.ts`](../../../../packages/components/src/lib/vscode-theme/vscode-theme-dom.ts) 与 [`vscode-theme-css.ts`](../../../../packages/components/src/lib/vscode-theme/vscode-theme-css.ts) 注入根级 `--*` 变量，构成**跨版本 SemVer 稳定契约**；第二层 `manifest.styles` / `lody.styles.add` 作为宿主托管的本地 Opt-in 逃生舱（随停用/HMR 自动卸载、`lody --safe-mode` 一键旁路、不跨协作者同步），**明确只承诺公开 `--*` 变量稳定而不冻结内部 React DOM 层级**。

### 4. 删除高危与投机接口，收窄 Phase 1 范围

- **直接删除：**（1）`machine.beforeSessionTurn`（在验签后向 Turn 拼接未签名提示词附录会侵蚀 E2EE `memberInput` 端到端提示词完整性，上下文注入统一走显式 `defineAttachmentSource` 或 `defineTool`）；（2）`ctx.sessionDataDir`（合并回单一 `ctx.dataDir` 并按不可变 `toolCallId` 寻址，解除与 `session/fork` 的耦合）；（3）`lody plugin propose` 审批卡片协议（改为硬性规则：插件安装与启停严禁暴露在 Agent MCP 工具面，仅限人类 CLI/桌面设置操作）；（4）未上线兼容别名（`useHost`、`hostQueries`、`HostActions`）与脱离 [`history-apply.ts`](../../../../packages/shared/src/acp/history-apply.ts) 真实数据模型的 `results.add({ mimeType })`。
- **明确延后至 Phase 1 之后：** `createLodyClient()` 外设回环服务、`manifest.agentRoles` / `roleTarget`、`manifest.settings` / `usePluginSettings`、`defineObservation` + `waitCondition`、`machine.onSessionEvent`、`businessKeyScope: 'project'`、`acpProviders` / `mcpServers`、`workspace.pages.add` 以及全局 `shell.*` / `commands.add`。

## 加密工作区（E2EE）插件安全边界

在 E2EE 工作区（[`specs/e2ee-foundations.zh.md`](../../../../specs/e2ee-foundations.zh.md)）中，插件须满足以下安全约束：

1. **访客（`read`）与写者 RPC 严格切分：** 遵循 [`e2ee-rpc.ts`](../../../../packages/shared/src/e2ee-rpc.ts) 与 [E2EE 只读查询](../../implemented/architecture/2026-10-28-e2ee-read-queries.zh.md)「方法名不能证明代码只读」原则，插件子进程运行的 `plugin/query`、`plugin/mutate` 与 `plugin/attachment-*` 绝不进入 `E2EE_READ_QUERY_METHODS`，一律要求非访客 `authorizeExecution`（`<15 分钟` 账本新鲜度）；访客端对插件描述子调用 `useQuery` 收敛为 `{ status: 'unavailable', reason: 'forbidden' }`，仅可查看内联 ≤16 KiB 历史快照与宿主受控 `useLodyQuery` 只读数据。
2. **机器拥有者独占与按项目 `MachineSharing` 门控：** 遵循 [`specs/e2ee/machine-sharing.zh.md`](../../../../specs/e2ee/machine-sharing.zh.md) 与 [`packages/e2ee-machine-sharing/AGENTS.md`](../../../../packages/e2ee-machine-sharing/AGENTS.md)，插件安装/启停、`binding: 'installation'` 设置、`ctx.env` 密钥及 `'machine'` 作用域调用**仅限机器拥有者本人**；项目协作者仅在 `MachineSharing` 实时共享目标机器及全部关联项目时方可调用 `'project'` 与 `'session'` 作用域处理函数。
3. **签名执行意图溯源（`e2eeIntent`）与 20 次派生上限：** 遵循 [`e2ee-execution-intent.ts`](../../../../packages/shared/src/e2ee-execution-intent.ts)、[签名执行意图](../../implemented/architecture/2026-11-10-e2ee-signed-execution-intent.zh.md)与[共享成员派生](../../implemented/architecture/2026-10-31-e2ee-shared-member-derivation.zh.md)，前端 `useLody().sessions.create` / `send` 在个人设备上签发 `memberInput`（`kind = 1`）；守护进程侧仅活跃人工根 Turn 内的 `ToolExecutionContext` 可签发携带 `derivedFrom` 的 `machineInput`（`kind = 2`，严格继承共享成员每根 Turn 最多 20 次派生配额与禁止跨机派生规则）；无人工根 Turn 的 `MachineContext` 调用 `create` / `send` 一律报 `forbidden`。
4. **256 KiB Iroh 单帧快路径与 4 MiB 产物上限：** 遵循 [E2EE Iroh 传输](../../implemented/architecture/2026-11-10-e2ee-iroh-transport.zh.md)，`MAX_PLUGIN_RPC_REQUEST_BYTES`（256 KiB）保证桌面直连读写落在单个 1 MiB `purpose 8` Iroh 快路径帧内；`MAX_PACKED_CLIENT_BUNDLE_BYTES`（4 MiB）确保 Phase 2 远端产物分发可直接复用既有 256 KiB `purpose 9` 分页通道。
5. **保管域隔离、脱敏与明文分享兜底：** E2EE 守护进程 `ctx.dataDir` 位于 `<account>/<workspace>/<genesis>/<signing-key>` 专属身份目录下（[`apps/cli/src/lib/e2ee/AGENTS.md`](../../../../apps/cli/src/lib/e2ee/AGENTS.md)）；Phase 2 客户端产物与信任缓存绑定同一保管域（[`specs/e2ee/client-custody.zh.md`](../../../../specs/e2ee/client-custody.zh.md)、[`specs/e2ee/desktop-custody.zh.md`](../../../../specs/e2ee/desktop-custody.zh.md)），在模式 `unknown` 时禁止挂载并在确认移除/撤销时原子擦除。Presence 与遥测剥离全部插件标识与异常堆栈；明文静态分享（[明文分享显式同意](../../implemented/feature/2026-10-28-e2ee-share-plaintext-consent.zh.md)）仅导出历史内联 ≤16 KiB 结果且匿名页固定使用宿主内置回退视图，绝不上传 `ctx.dataDir` 或执行第三方 `client.js`。

## 被否决的替代方案

1. **单机共享 `PluginWorker` + 金丝雀复现进程 + 只读查询静默重试：** 已否决。共享进程迫使宿主为无法归因的同步死循环与 OOM 发明金丝雀复现，而静默重试无法保证无副作用的插件 `defineQuery` 则违背确定性故障边界；每启用 `machine` 插件独立子进程直接从根因消灭跨插件故障污染。
2. **整包 `revision` + `machineDigest` 三哈希协同校验：** 已否决。将前后端拆解为前端 `clientDigest` 信任/实例生命周期与后端子进程运行时 `instanceId` 后，前端热更新天然不重启后端子进程、不中断在途 Turn，无需维护复杂的三哈希状态机。
3. **`machine.beforeSessionTurn` 验签后隐式注入提示词：** 已否决。在个人设备签发 `memberInput` 之后由机器侧钩子隐式拼接提示词破坏了 E2EE 端到端提示词完整性与可审计性。
4. **以「防遮挡弹窗」为由彻底禁止托管自定义 CSS（`styles`）：** 已否决。在非沙箱前端插件模型下禁止 `styles` 并不能阻止 `client.js` 操作 DOM，反而丧失宿主对 `<style>` 节点的停用清理与 `--safe-mode` 旁路控制；采用「稳定 `--*` 主题变量契约 + 不承诺冻结内部 DOM 的托管 `styles`」同时兼顾主题生命力与重构自由度。
5. **在核心层硬编码 `swarm` 分组或使用单例 `sidebar.replace`：** 已否决。公开 `lodyQueries` 搭配三层正交侧边栏既复用了既有 `SessionMeta` 父子/角色关系，又消除了多插件侧边栏独占冲突。
6. **将 `plugin/query` 开放给 E2EE `read` 访客，或允许无根 `MachineContext` 签发 `machineInput`：** 已否决。前者违背访客只读绝不触发目标机器任意代码执行的铁律，后者会把守护进程变成无根执行签名预言机。

## 影响与未决边界

- **按需承担独立子进程内存：** 仅声明了 `machine` 入口且被启用的插件占用独立 Node 子进程（纯前端、主题与 Skill 插件后端零进程），换取崩溃零连坐与确定性 `SIGKILL` 回收。
- **E2EE 访客端与无根后台诚实受限：** E2EE 访客仅查看历史内联 ≤16 KiB 快照与 `useLodyQuery` 只读视图，插件 `useQuery` 诚实返回 `forbidden`；无人工根 Turn 的后台处理函数不可主动创建或发送 E2EE 会话消息。
- **原生移动端留白：** `apps/mobile` 暂不评估执行插件 `client.js`，继续使用宿主内置结构化回退视图。

## 验证范围

- [`scripts/plugin-sdk-contracts.test.mjs`](../../../../scripts/plugin-sdk-contracts.test.mjs) 在纯浏览器与纯 Node 隔离 TypeScript 配置下编译校验精简后的 [`sdk/shared.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)、[`sdk/client.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/client.d.ts)、[`sdk/machine.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/machine.d.ts)、[`sdk/manifest.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/manifest.d.ts)、反向断言（[`contracts.ts`](../../../../scripts/fixtures/plugin-sdk/contracts.ts)、[`machine-contracts.ts`](../../../../scripts/fixtures/plugin-sdk/machine-contracts.ts)）及四个参考插件（`test-report`、`issue-context`、`worktrees`、`focus-sidebar`），并对 `issue-context` 的 `ctx.dataDir` 原子文件持久化执行并发写入与故障注入回归测试。
- 尚未验证项：`PluginHost` 子进程排空与强杀回收、`--dev` 独立编译子进程、`ClientPluginHost` 订阅/样式清理、`lody --safe-mode`，以及全部 E2EE RPC、`MachineSharing`、`e2eeIntent` 与保管域擦除运行时实现。
