# 插件架构演进收敛与 E2EE 工作区边界

Status: proposed
Translation: current

[English](2026-11-22-plugin-architecture-and-e2ee-boundaries.md)

## 摘要

深入审视初版 [Lody Plugin System 架构设计](../../../../specs/plugin-system.zh.md) 并对照 Paseo 与 T3 Code 生态演进后，我们识别出基础 SDK 契约的结构性缺口——全包 `revision` 冻结导致纯 UI 热改打断长耗时在途工具、共享 `PluginWorker` 卡死或 OOM 缺乏准确归因、长耗时工具缺失 `running` 态实时渲染与按会话存储回收、阉割版宿主摘要迫使向组件 props 硬塞状态、分裂的单例 `sidebar.replace` 在多插件并存时会相互夺舍覆盖、缺少原地回复后台 `ask_user_question` 的交互原语，以及 Agent 可静默自启插件的越权风险——同时初版尚未定义加密工作区（E2EE）的完整安全模型。本文提议引入第三哈希 `machineDigest`、只读透明重试与金丝雀故障核实、`running` 态 `ToolRenderProps` 配合 `ctx.sessionDataDir`、内外同构 `LodyClient`（`useLody()`、`ctx.lody` + `beforeSessionTurn`、本机回环鉴权 `createLodyClient()`）与 `lodyQueries`（`useLodyQuery`）、三层正交侧边栏（`sidebar.sessionRow.decorate` + `<SessionRow />`、`headerItems`/`footerItems` + `<SidebarRow />` + `screens.add`、可切换 `sidebar.views.add`）配合 `sessions.answerQuestion`、可移植 `agentRoles`、种子色与 VS Code `themes` 及按需开启的外壳 JS/CSS 扩展，并建立九项 E2EE 强制边界。该方案保持极薄组件 props、无需在核心层硬造僵化的 `swarm` 分组概念，且在不改动底层 E2EE 密文帧协议的前提下闭合安全边界，代价是 E2EE 访客不可调用动态插件 `useQuery`、`'machine'` 作用域仅限机器拥有者，且守护进程创建新会话受签名 `e2eeIntent` 门控。目前仅完成 TypeScript SDK 契约与参考插件夹具校验，运行时宿主与 E2EE 门禁尚待实现。

## 基础插件契约的深层发现与板上钉钉的改进

### 值得坚守的三项涌现能力

1. **零大模型开销的确定性交互闭环：** 16 KiB 有界 `tool_call` 历史快照配合 `ToolRenderProps.appendToDraft`、`lody.drafts.append` 与 `defineMutation`，使测试分诊、告警筛选等高频操作直接在客户端或机器 RPC 上闭环，无需为纯 UI 筛选额外消耗 LLM Turn 与 Token。
2. **不脱离宿主刹车的 24/7 无头哨兵：** `defineObservation` 与 `sessions.create({ waitCondition })` 组合让 `headless` 机器天然成为全天候事件哨兵，同时每次唤醒仍严格经过标准 Session Inbox 准入、权限确认框与即时 Stop 制动，杜绝不可审计的隐形自治循环。
3. **单机离线不拖垮全局的工作区视图：** `WorkspaceRef` 剥离 `machineId` 后，`lodyQueries.machines` / `projects` / `sessions` 直接读取客户端已同步目录状态；多机开发场景下某台开发机休眠离线时，侧边栏依然秒开，仅对在线 `MachineRef` 按需扇出实时查询。

### 结构性缺口与契约收敛

1. **内外同构 `LodyClient`、公开原始数据 SDK（`lodyQueries`）与三层正交侧边栏：**
   - **极薄组件入参、内外同构 SDK：** 摒弃向 `ProjectPageProps` 硬塞 `repositoryState` 和阉割 8 字段窄摘要的做法，统一收敛为内外同构的 `LodyClient`（客户端 `useLody()`、守护进程 `ctx.lody`、本机回环鉴权外设 `createLodyClient()` 供 Raycast / 浏览器 PR 徽章 / CLI 脚本共用）与 `lodyQueries`（`useLodyQuery`），直接开放共享 Loro/Flock 原始存储（含 `openedBySessionId` / `openedByRootSessionId` / `agentRoleId` / `pendingInteraction` 的 `sessions`、含结构化 `pendingQuestion` 的 `sessionDetail`、`agentRoles`、`machines`、`projects`、`members`、`schedules`）及已鉴权 `MachineRpc`/云端查询（`gitState`、`worktrees`、`sessionDiff`、`filePreview`、`pullRequests`、`skills`）。
   - **用 Paseo 式三层正交侧边栏取代分裂的 `sidebar.replace` 与硬编码 Swarm 分组：** T3 Code 社区之所以分化出 7+ 个硬 Fork，根源在于缺少正交 UI 扩展层；而粗暴的单例 `sidebar.replace` 又会让「悬停问答插件」与「多 Agent 树侧栏插件」互相冲突覆盖。对齐 [`sidebar-surface.ts`](../../../../packages/components/src/components/sidebar-surface.ts) 拆分为三层后：① `sidebar.sessionRow.decorate` 无损挂载行尾徽章与悬停弹窗（配合 `lody.sessions.answerQuestion` 经 [`use-permission-response.ts`](../../../../packages/components/src/hooks/use-permission-response.ts) 原地回答 [`ask-user-question.ts`](../../../../packages/shared/src/acp/ask-user-question.ts) 多步提问，而工具 `permission` 审批严格留在宿主内核）；② `sidebar.headerItems`/`footerItems` + `<SidebarRow />` + `screens.add` 打开全屏战情画布；③ `sidebar.views.add` 注册可多插件并存切换的纯自定义侧边栏列表体，且渲染 `<SessionRow />` 时自动继承所有行级装饰器。
2. **可移植多 Agent 角色蓝图、前置拦截与事件钩子、种子色/VS Code 主题及外壳定制：**
   - **可移植 `manifest.agentRoles` + `beforeSessionTurn` + `onSessionEvent`：** 现有工作区 `AgentRole` 记录（[`agent-role.ts`](../../../../packages/shared/src/agent-role.ts)）强绑定创建者自己的 `(machineId, agentConfigId)`。在 `lody.plugin.json` 中引入机器无关的 `agentRoles` 角色蓝图（配合 `manifest.settings` 的 `roleTarget` 选择器与 `pluginRoleId`）、Turn 启动前附加工作树/环境上下文的 `machine.beforeSessionTurn`，以及毫秒级接力的 `machine.onSessionEvent`，即可开箱分享完整多 Agent 协作流。
   - **种子色/VS Code 双模主题与本地外壳 CSS/JS 开放层：** `manifest.themes` 与动态 `lody.themes.add` 同时支持完整 VS Code 主题 JSON 与紧凑种子色板（`PluginThemeSeedColors`，由 [`vscode-theme-dom.ts`](../../../../packages/components/src/lib/vscode-theme/vscode-theme-dom.ts) 自动推演界面、Diff、Monaco、Shiki 与终端全套色板），让 Agent 用两句提示即可实时生成热加载主题。为避免过度防御扼杀插件趣味性，`manifest.styles` / `lody.styles.add`（面向稳定的 `data-lody-slot` 语义属性）、全局悬浮层 `lody.shell.overlays.add`、状态栏 `lody.shell.statusBar.add` 与全局快捷键 `lody.commands.add` 对本地显式开启的用户完全开放（绝不自动传染至其他协作者浏览器），并由 `lody --safe-mode` 提供一键安全兜底。
3. **三哈希切分（`clientDigest` · `machineDigest` · `revision`）：** 初版在 Agent Turn 启动时冻结全包 `revision`，导致 `--dev` 期间哪怕只调整 `client.tsx` 样式、主题或 `skills/` 文案，也会令正在执行的多分钟 Turn 后续工具调用因版本变化直接报错。新增 `machineDigest = SHA-256(manifest.machine + machine.js + toolSchemas)` 后，在途 Turn 仅冻结 `(pluginId, machineDigest)`，跨端 `client ↔ machine` RPC 继续校验全包 `revision`，浏览器信任与缓存继续绑定 `clientDigest`。
4. **`PluginWorker` 读写差异化恢复与金丝雀毒丸核实：** 单台机器共享一个 `child_process.fork` `PluginWorker` 可将常驻内存压在约 `40–60 MiB`，但同步死循环或 V8 堆 OOM 会令辅助进程无堆栈退出。改进后：
   - 进程重启时，在途只读 `defineQuery` 与 `defineObservation` 在新进程中透明重试一次，且 `worker_restarted` / `unavailable` 瞬时错误不计入 Automation 连续 5 次永久 `failed` 熔断计数；
   - 在途副作用 `defineMutation` 与 `defineTool` 诚实返回 `outcome_unknown`，严禁自动重放；
   - 未归因卡死或 OOM 先将可疑插件放入短生命周期隔离金丝雀进程（canary worker）独立复现，确认肇事后才标记 `plugin_faulted`。
5. **运行态实时工具卡片、`ctx.sessionDataDir`、分级业务键、安全参数化 `waitCondition` 与 `lody plugin propose`：**
   - `ToolRenderProps` 在 `status: 'running'` 即挂载，配合宿主托管的按会话目录 `ctx.sessionDataDir`（随 Session 删除自动回收、跨 `session/fork` 隔离）与 `ctx.invalidate` + `useQuery`，在零 Loro CRDT 膨胀下实现实时进度；
   - `sessions.create` / `drafts.open` 拓宽支持 `MachineRef | ProjectRef`，新增团队级 `businessKeyScope: 'project'`、`waitCondition.params`（运行于禁用 `ctx.exec` 的只读 [`codemode.ts`](../../../../apps/cli/src/automations/programs/codemode.ts)）、`host.panels.openSession` 以及 `lody plugin propose` 人类审批卡片。

## 加密工作区（E2EE）的九项插件安全边界

在 E2EE 工作区（[`specs/e2ee-foundations.zh.md`](../../../../specs/e2ee-foundations.zh.md)）中，插件跨越了访客只读、按项目机器共享、执行意图验签、P2P 帧路由与密钥保管等多个核心平面，须同时满足九项专门设计：

### 1. 访客（`read`）与写者（`admin` / `member`）RPC 严格切分

根据 [`e2ee-rpc.ts`](../../../../packages/shared/src/e2ee-rpc.ts) 与 [E2EE 只读查询](../../implemented/architecture/2026-10-28-e2ee-read-queries.zh.md)，`E2EE_READ_QUERY_METHODS` 遵循「方法名不能证明代码只读」原则。由于插件 `defineQuery` 在 `PluginWorker` 中运行任意 Node 代码且可读取 `ctx.env` 与磁盘，绝不能将 `plugin/query` 放入访客白名单。

- **纳入 `E2EE_READ_QUERY_METHODS`：** 仅限宿主静态托管、无插件代码执行的 `plugin/catalog` 与 `plugin/bundle-chunk`（以及支撑 `useLodyQuery` 的既有宿主受控只读方法）。`read` 访客可据此校验 `clientDigest` 并只读渲染历史内联 ≤16 KiB 卡片或视图。
- **要求非访客 `authorizeExecution`（`<15 分钟` 内存账本新鲜度）：** `plugin/query`、`plugin/mutate` 与 `plugin/attachment-*`。访客端对插件描述子调用 `useQuery` 时平稳收敛为 `{ status: 'unavailable', reason: 'forbidden' }`。

### 2. 机器拥有者独占与按项目 `MachineSharing` 门控

根据 [`specs/e2ee/machine-sharing.zh.md`](../../../../specs/e2ee/machine-sharing.zh.md) 与 [`packages/e2ee-machine-sharing/AGENTS.md`](../../../../packages/e2ee-machine-sharing/AGENTS.md)，E2EE 机器默认归属拥有者私有，仅按项目粒度显式共享给工作区协作者；同一台开发机往往同时存放已共享团队项目与未共享私人仓库。

- **仅限机器拥有者本人：** 安装、启用、停用或 `--dev` 热加载插件；配置 `binding: 'installation'` 设置与 `ctx.env` 密钥；以及调用任何 `'machine'` 作用域的 `defineQuery` / `defineMutation`（防止协作者借机器级查询窥探该机器上未共享项目的状态）。
- **项目协作者可调用范围：** 仅限 `'project'` 与 `'session'` 作用域的插件查询、变更与附件检索，且每次调用均实时核验 `MachineSharing` 当前同时共享了该 `machineId` 及目标引用绑定的全部项目（未绑定项目的 E2EE 普通 Session 仅限机器拥有者访问）。

### 3. 签名执行意图溯源（`e2eeIntent`）与共享成员 20 次派生上限

根据 [`e2ee-execution-intent.ts`](../../../../packages/shared/src/e2ee-execution-intent.ts)、[签名执行意图](../../implemented/architecture/2026-11-10-e2ee-signed-execution-intent.zh.md)与[共享成员派生](../../implemented/architecture/2026-10-31-e2ee-shared-member-derivation.zh.md)，E2EE 机器拒绝任何无签名授权的提示词执行：

- **前端 `useLody().sessions.create` / `send` 与 `answerQuestion`：** `create` / `send` 在个人设备上就地对规范化提示词、附件快照及 `waitCondition` 签发 `memberInput`（`kind = 1`）；`answerQuestion` 经非访客 `WorkspaceWriter` 仅提交 `ask_user_question` 答复（拒绝代批工具 `permission`）；`createLodyClient()` 严格限定本机回环并校验本地保管域签发的每客户端令牌；`machine.beforeSessionTurn` 仅在所属机器验签通过后附加外部环境上下文而不修改已签名提示词。
- **机器侧 `ToolExecutionContext.host.sessions.create` / `send`：** 由守护进程签发 `machineInput`（`kind = 2`），强制携带锚定当前已验签人工根 Turn 的 `derivedFrom: { sessionId, userTurnId }`，严格继承共享成员每根 Turn **最多 20 次派生预留配额**及**禁止跨机器派生规则**（跨机直接返回 `e2ee_derivation_cross_machine_unsupported`）。
- **无人工根 Turn 的守护进程 `MachineContext`（`defineMutation`、`defineObservation`、`onSessionEvent`）：** 在 E2EE 工作区中调用 `sessions.create` / `send` 一律拒绝（`forbidden`），杜绝协作者借 `plugin/mutate` 或外部事件诱导机器私钥充当无根签名预言机。
- **只读 `waitCondition` 意图绑定：** 等待态 Session 的 `waitCondition` 代码与 `params` 纳入创建者的 `memberInput`（或 `derivedFrom` `machineInput`）签名载荷，且在唤醒求值时强制禁用 `CodeMode` 的 `ctx.exec`，防止共享项目协作者借等待脚本越界执行宿主机任意 Shell 命令。

### 4. 传输分帧：256 KiB Iroh 单帧快路径与 `purpose 9` 产物分片

根据 [E2EE Iroh 传输](../../implemented/architecture/2026-11-10-e2ee-iroh-transport.zh.md)，Desktop↔Machine 直连 QUIC P2P 快路径（中位延迟约 `112 ms`，且在云端 Streams 故障期间仍可直连）仅承载单帧 `purpose 8` 请求（密文信封 `≤ 1 MiB`），超限则会退化为多信封 Streams 转发（约 `733 ms`）：

- 将 `plugin/query` 与 `plugin/mutate` 单次请求硬上限设为 **`MAX_PLUGIN_RPC_REQUEST_BYTES`（256 KiB）**，确保桌面端插件读写始终落在单个 1 MiB `purpose 8` Iroh 快路径帧内；纯浏览器 `web` 端则走标准加密 Streams RPC。
- `plugin/bundle-chunk` 直接复用既有 256 KiB `purpose 9` 只读响应分页机制（`MAX_PACKED_CLIENT_BUNDLE_BYTES` = 4 MiB，远低于 E2EE 64 页 / 16 MiB 分页上限），对 `specs/e2ee-foundations.zh.md` 零线协议改动。

### 5. 前端产物/信任保管域隔离与成员移除/设备撤销终态擦除

在 E2EE 工作区中，团队自研 `--dev` 插件或内部打包的 `client.js` 往往内含私有业务 Schema、内部系统地址与提示词模板。若仅按 `clientDigest` 明文缓存在浏览器全局 IndexedDB，不仅会在共享设备 profile 上泄露私有前端逻辑，还会在成员被移除后残留：

- E2EE 前端插件产物缓存、信任授权记录与持久化插件设置必须严格绑定 `<account>/<workspace>/<genesis>/<signing-key>` 保管域（[`specs/e2ee/client-custody.zh.md`](../../../../specs/e2ee/client-custody.zh.md)、[`specs/e2ee/desktop-custody.zh.md`](../../../../specs/e2ee/desktop-custody.zh.md)）——使用安装 KEK 或当前工作区内容密钥加密包裹，或仅在已验证解锁的内存运行期持有。
- `ClientPluginHost` 受 `RuntimeProvider` 的 E2EE 模式与 epoch 准入门控（[`packages/platform/AGENTS.md`](../../../../packages/platform/AGENTS.md)），在工作区模式处于 `unknown` 期间绝不提前挂载任何缓存插件。
- 当收到确切验证的 `e2ee_member_removed` 或 `e2ee_device_revoked` 终态结果时，随该实例托管内容一并原子擦除对应的插件缓存与信任记录。

### 6. 守护进程 `dataDir` / `sessionDataDir` 身份目录隔离与租约清理

遵循 [`apps/cli/src/lib/e2ee/AGENTS.md`](../../../../apps/cli/src/lib/e2ee/AGENTS.md)：

- E2EE 插件的 `dataDir` 与 `sessionDataDir` 必须位于 `e2ee/<account-hash>/<workspace>/content/<genesis>/<signing-key>/plugins/<pluginId>/` 下，强制所有权私有权限（`0700` / Windows owner DACL）并拒绝符号链接逃逸，绝不与明文工作区或重配对后的新身份混用目录。
- 本地身份重置（local identity reset）时随旧身份目录一并归档封存；确认成员移除（`RemoveMember`）时随工作区托管内容彻底删除。

### 7. Presence 严格白名单与遥测脱敏

- 临时在线状态（Presence）严格执行字段白名单（`specs/e2ee-foundations.zh.md`）：发布前剥离当前激活的插件 ID、自定义侧栏/面板 ID 与在途插件工具名。
- 遥测系统（`packages/platform/AGENTS.md`）在 E2EE 工作区禁用会话重放，仅上报固定宿主诊断码（`revision_mismatch`、`plugin_faulted`、`outcome_unknown`），严禁携带插件包名、Zod 校验差异或插件异常堆栈。

### 8. 明文静态 Session 分享边界

遵循 [明文分享显式同意](../../implemented/feature/2026-10-28-e2ee-share-plaintext-consent.zh.md)：

- 用户显式确认导出明文静态 Session 分享快照时，导出范围包含已写入会话历史的 ≤16 KiB `tool_call` 内联结果，但绝不隐式读取或上传机器侧 `ctx.dataDir` / `ctx.sessionDataDir` 中的大文件。
- 面向外部匿名访问者的公开分享页固定使用宿主内置结构化 JSON/表格回退视图展示插件结果，绝不在工作区信任上下文之外拉取或执行第三方 `client.js`。

### 9. 零云端托管令牌与宿主机网络外发显式披露

- 遵循 `apps/cli/src/lib/e2ee/AGENTS.md`，E2EE 守护进程不注入任何云端托管 GitHub 安装令牌或云端凭据代理；插件仅能读取机器拥有者本人在所属机器上显式写入 `ctx.env` 的密钥。
- 在 E2EE 工作区启用声明了 `env`、`attachmentSource`、`mcpServers` 或 `acpProviders` 的插件时，界面向机器拥有者显式披露：该插件 `machine` 代码具备宿主机 OS 网络访问权限，可能将输入发往插件配置的外部服务。

## 被否决的替代方案

1. **在核心层硬造专用 `swarm` 分组实体、向组件 props 预塞数据，或使用独占覆盖的单例 `sidebar.replace`：** 已否决。`SessionMeta` 原生已维护 `openedBySessionId`、`openedByRootSessionId` 与 `agentRoleId`；而单例 `sidebar.replace` 会导致行级增强插件与自定义视图插件互相打架。公开 `lodyQueries` 并拆分为 `sidebar.sessionRow.decorate`（跨 `<SessionRow />` 自动组合）、`headerItems`/`footerItems` + `screens.add` 与可并存切换的 `sidebar.views.add`，同时消灭了硬编码分组、臃肿入参与多插件覆盖冲突。
2. **因防卫过当而一刀切禁止桌面客户端全局 CSS 与外壳悬浮层：** 已否决。完全封死主题、CSS Snippets、悬浮雷达与状态栏挂件会扼杀社区插件的趣味性；将 `styles` 与 `shell.*` 限定于主动开启的当前客户端（绝不跨用户自动传染）并配齐 `lody --safe-mode` 一键逃生舱，既释放了高可玩性又守住了核心恢复底线。
3. **将 `plugin/query` 纳入 `E2EE_READ_QUERY_METHODS` 开放给 `read` 访客：** 已否决。`defineQuery` 在 `PluginWorker` 中运行任意插件 Node 代码并可访问 `ctx.env` 与宿主机文件系统；向访客开放会打破「E2EE 访客只读绝不触发目标机器任意代码执行或秘密访问」的核心防线。
4. **跨工作区共用仅按 `clientDigest` 寻址的全局明文 IndexedDB 缓存：** 已否决。E2EE 团队内部开发（`--dev`）或私有打包的 `client.js` 含有敏感业务逻辑与内部接口定义，必须绑定 `<account>/<workspace>/<genesis>/<signing-key>` 保管域并在撤销或移除时可彻底擦除。
5. **允许守护进程 `defineMutation`、`defineObservation` 或 `onSessionEvent` 在无 `derivedFrom` 时直接签发 `machineInput`：** 已否决。若无人工根 Turn 绑定即可签发 `machineInput`，任何可调用 `plugin/mutate` 的协作者或外部事件都能绕过个人设备 `memberInput` 签名与 20 次派生上限，把守护进程变成无根执行签名预言机。
6. **通过 Loro `HistoryWriter` 流式追加长耗时工具进度，或每插件独占一个 OS 子进程：** 流式写入 Loro 会造成历史膨胀与 E2EE 密文帧风暴（由运行态 `ToolRenderProps` + `useQuery` 解决）；每插件单开 Node 进程会成倍放大常驻内存（由单共享 `PluginWorker` + 短生命周期金丝雀复现进程解决）。

## 影响与未决边界

- **E2EE 访客端诚实退化：** E2EE 访客可直接查看 ≤16 KiB 内联历史快照与 `useLodyQuery` 同步目录视图，但调用需 `PluginWorker` 执行的插件 `useQuery` 时会诚实呈现 `{ status: 'unavailable', reason: 'forbidden' }`。
- **E2EE 全天候等待任务须由个人设备或人工根 Turn 预先布防：** E2EE 工作区的 24/7 值守 Session 须由用户在前端点击（签发含 `waitCondition` 的个人设备 `memberInput`）或在人工根 Turn 工具内（签发 `derivedFrom` `machineInput`）预先创建为 `waiting` 态，而不能在无人工根 Turn 的后台 `defineObservation` 或 `onSessionEvent` 内临时新建 Session。
- **原生移动端渲染留白：** `apps/mobile` 暂不评估执行插件 `client.js` bundle，继续回退至宿主内置结构化视图。

## 验证范围

- [`scripts/plugin-sdk-contracts.test.mjs`](../../../../scripts/plugin-sdk-contracts.test.mjs) 在纯浏览器与纯 Node 两套隔离 TypeScript 配置下编译校验 [`sdk/shared.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)、[`sdk/client.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/client.d.ts)、[`sdk/machine.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/machine.d.ts)、[`sdk/manifest.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/manifest.d.ts)、[`contracts.ts`](../../../../scripts/fixtures/plugin-sdk/contracts.ts)、[`machine-contracts.ts`](../../../../scripts/fixtures/plugin-sdk/machine-contracts.ts) 及四个参考插件（`test-report`、`issue-context`、`worktrees`、`focus-sidebar`），覆盖内外同构 `useLody` / `createLodyClient` / `ctx.lody`、`lodyQueries` + `useLodyQuery`、三层侧边栏（`sessionRow.decorate`、`headerItems` + `screens.add`、`sidebar.views.add`）与 `sessions.answerQuestion`、可移植 `agentRoles`、种子色与 VS Code `themes`、`styles`、`shell.*`、`beforeSessionTurn`、`onSessionEvent`、运行态 `ToolRenderProps`、`ctx.sessionDataDir`、`businessKeyScope`、`waitCondition.params` 及 RPC/产物字节上限常量，并对 `issue-context` 执行临时文件读写故障注入回归测试。
- 待实现验收项：`PluginHost`、`ClientPluginHost`、`PluginWorker` 金丝雀隔离、`sessionDataDir` 回收与分叉隔离、`lody plugin propose` 以及全部 E2EE RPC、`MachineSharing`、`e2eeIntent` 与保管域擦除运行时逻辑。
