# 插件架构演进收敛与 E2EE 工作区边界

Status: proposed
Translation: current

[English](2026-11-22-plugin-architecture-and-e2ee-boundaries.md)

## 摘要

深入审视初版 [Lody Plugin System 架构设计](../../../../specs/plugin-system.zh.md) 后，我们识别出基础 SDK 契约的五处结构性缺口——全包 `revision` 冻结导致纯 UI 热改打断长耗时在途工具、共享 `PluginWorker` 卡死或 OOM 时缺乏准确归因、长耗时工具缺失 `running` 态实时渲染与按会话存储回收、`CodeMode` 等待条件依赖源码字符串拼接且缺乏团队级业务键去重，以及 Agent 可静默自启插件的越权风险——同时初版尚未定义加密工作区（E2EE）的完整安全模型。本文提议引入第三哈希 `machineDigest`、只读透明重试与金丝雀故障核实、`running` 态 `ToolRenderProps` 配合宿主托管 `ctx.sessionDataDir`、参数化只读 `waitCondition` 与分级 `businessKeyScope`、`lody plugin propose` 人类审批流，并建立覆盖访客/写者 RPC 切分、按项目机器共享、`e2eeIntent` 执行溯源、Iroh 单帧快路径、双端保管域擦除及遥测/分享脱敏的九项 E2EE 强制边界。该方案在不改动底层 E2EE 账本与密文帧协议、不引入 Loro CRDT 写放大的前提下闭合安全边界，代价是 E2EE 访客不可调用动态 `useQuery`、`'machine'` 作用域在 E2EE 中仅限机器拥有者，且无人工根 Turn 的守护进程上下文不可直接签发新会话。目前仅完成 TypeScript SDK 契约与参考插件夹具校验，`PluginHost`、`ClientPluginHost` 及 E2EE 运行时门禁尚待实现。

## 基础插件契约的深层发现与板上钉钉的改进

### 值得坚守的三项涌现能力

1. **零大模型开销的确定性交互闭环：** 16 KiB 有界 `tool_call` 历史快照配合 `useHost().composer.appendText` 与 `defineMutation`，使测试分诊、告警筛选等高频操作直接在本地或机器 RPC 上闭环，无需为纯 UI 筛选额外消耗 LLM Turn 与 Token。
2. **不脱离宿主刹车的 24/7 无头哨兵：** `defineObservation` 与 `sessions.create({ waitCondition })` 组合让 `headless` 机器天然成为全天候事件哨兵，同时每次唤醒仍严格经过标准 Session Inbox 准入、权限确认框与即时 Stop 制动，杜绝不可审计的隐形自治循环。
3. **单机离线不拖垮全局的工作区视图：** `WorkspaceRef` 剥离 `machineId` 后，`hostQueries.machines` / `projects` / `sessions` 直接读取客户端已同步目录状态；多机开发场景下某台开发机休眠离线时，Focus 等工作区侧栏依然秒开，仅对在线 `MachineRef` 按需扇出实时查询。

### 五项结构性缺口与契约收敛

1. **三哈希切分（`clientDigest` · `machineDigest` · `revision`）：** 初版在 Agent Turn 启动时冻结全包 `revision`，导致 `--dev` 期间哪怕只调整 `client.tsx` 样式或 `skills/` 文案，也会令正在执行的多分钟 Turn 后续工具调用因版本变化直接报错。新增 `machineDigest = SHA-256(manifest.machine + machine.js + toolSchemas)` 后，在途 Turn 仅冻结 `(pluginId, machineDigest)`，跨端 `client ↔ machine` RPC 继续校验全包 `revision`，浏览器信任与缓存继续绑定 `clientDigest`，三者职责正交。
2. **`PluginWorker` 读写差异化恢复与金丝雀毒丸核实：** 单台机器共享一个 `child_process.fork` `PluginWorker` 可将常驻内存压在约 `40–60 MiB`，但同步死循环（`while(true)`）或 V8 堆 OOM 会令整个辅助进程无堆栈退出——若直接将当时恰有在途 `defineQuery` 的无辜插件打成 `plugin_faulted`，会造成跨插件误杀。改进后：
   - 进程重启时，在途只读 `defineQuery` 与 `defineObservation` 在新进程中透明重试一次，且 `worker_restarted` / `unavailable` 瞬时错误不计入 Automation 连续 5 次永久 `failed` 熔断计数；
   - 在途副作用 `defineMutation` 与 `defineTool` 诚实返回 `outcome_unknown`，严禁自动重放；
   - 未归因卡死或 OOM 先将可疑插件放入短生命周期隔离金丝雀进程（canary worker）独立复现，确认肇事后才标记 `plugin_faulted`。
3. **运行态实时工具卡片（`status: 'running'`）与 `ctx.sessionDataDir` 回收：** 初版仅在工具完成后挂载 `ToolRenderProps`，导致耗时数分钟的测试套件或构建过程黑盒等待；但若将高频流式进度写入 `HistoryWriter`，又会引发剧烈的 Loro CRDT 历史膨胀与 E2EE 密文帧写放大。将 `ToolRenderProps` 扩展为运行中即挂载（`status: 'running'`、`toolCallId`、`output?: undefined`），配合工具将中间进度写入 `ctx.sessionDataDir` 并调用 `ctx.invalidate` 驱动前端 `useQuery` 刷新，可在零 CRDT 膨胀下实现实时流式卡片，并在结束时一次性落盘 ≤16 KiB 摘要快照。同时宿主新增按会话隔离的 `ctx.sessionDataDir`，在 Session 删除时自动回收磁盘，并在 `session/fork` 分叉时保持存储隔离，避免插件级 `ctx.dataDir` 无限泄漏孤儿文件。
4. **分级业务键、未绑定项目的 `MachineRef` 会话创建与安全参数化 `waitCondition`：**
   - 将 `sessions.create` 与 `drafts.open` 的目标从仅限 `ProjectRef` 拓宽为 `MachineRef | ProjectRef`，对齐未绑定 Project 的一等普通 Session；
   - 新增 `businessKeyScope: 'user' | 'project'`（默认 `'user'`）：设为 `'project'` 时按 `(workspace, project, pluginId, businessKey)` 去重，防止团队多人在同一项目面板重复为同一个 Issue 启动多个后台值守 Session，而 `requestId` 仍严格保持按用户隔离；
   - 新增 `waitCondition.params`（注入 [`codemode.ts`](../../../../apps/cli/src/automations/programs/codemode.ts) 的 `ctx.params`）替代 JS 源码模板拼接以根除注入隐患；插件创建的 `waitCondition` 强制运行于**只读 `CodeMode`**（禁用 `ctx.exec`）；`defineObservation` 支持返回可选 `revision` 版本证据供唤醒准入二次核验，且 `ctx.invalidate` 拓宽支持 `ObservationDescriptor` 以提供推送辅助加速唤醒。
5. **卡片与伴随面板联动、有界 `results.add` 与 `lody plugin propose` 人类审批门禁：**
   - `host.panels.openSession(session, panelId, params?)`（`SessionPanelProps.params`）让紧凑工具卡片一键打开右侧伴随面板并定位至具体条目，消除模块全局变量耦合；
   - `lody.results.add(mimeType, ...)` 共享 16 KiB 内联上限，使任意 ACP/外部 MCP 工具产出的结构化资源块均可复用自定义渲染；
   - 鉴于 `machine` 代码持有 daemon OS 权限与 `ctx.env` 密钥，Coding Agent 现场生成插件后必须通过 `lody plugin propose <dir>` 渲染人类审批卡片（对齐 `AgentRoleProposalNotice`），严禁 Agent 静默执行 `lody plugin enable`。

## 加密工作区（E2EE）的九项插件安全边界

在 E2EE 工作区（[`specs/e2ee-foundations.zh.md`](../../../../specs/e2ee-foundations.zh.md)）中，插件跨越了访客只读、按项目机器共享、执行意图验签、P2P 帧路由与本地密钥保管等多个核心平面，须同时满足九项专门设计：

### 1. 访客（`read`）与写者（`admin` / `member`）RPC 严格切分

根据 [`e2ee-rpc.ts`](../../../../packages/shared/src/e2ee-rpc.ts) 与 [E2EE 只读查询](../../implemented/architecture/2026-10-28-e2ee-read-queries.zh.md)，`E2EE_READ_QUERY_METHODS` 遵循「方法名不能证明代码只读」原则。由于插件 `defineQuery` 在 `PluginWorker` 中运行任意 Node 代码且可读取 `ctx.env` 与本地磁盘，绝不能将 `plugin/query` 放入访客白名单。

- **纳入 `E2EE_READ_QUERY_METHODS`：** 仅限宿主静态托管、无插件代码执行的 `plugin/catalog`（插件清单与哈希）与 `plugin/bundle-chunk`（静态前端 `client.js` / `assets/` 分片）。`read` 访客可据此校验 `clientDigest` 并只读渲染 Loro 历史中已内联的 ≤16 KiB `tool_call` 自定义卡片。
- **要求非访客 `authorizeExecution`（`<15 分钟` 内存账本新鲜度）：** `plugin/query`、`plugin/mutate` 与 `plugin/attachment-*`。访客端调用 `useQuery` 时平稳收敛为 `{ status: 'unavailable', reason: 'forbidden' }`。

### 2. 机器拥有者独占与按项目 `MachineSharing` 门控

根据 [`specs/e2ee/machine-sharing.zh.md`](../../../../specs/e2ee/machine-sharing.zh.md) 与 [`packages/e2ee-machine-sharing/AGENTS.md`](../../../../packages/e2ee-machine-sharing/AGENTS.md)，E2EE 机器默认归属拥有者私有，仅按项目粒度显式共享给工作区协作者；同一台开发机往往同时存放已共享团队项目与未共享私人仓库。

- **仅限机器拥有者本人：** 安装、启用、停用或 `--dev` 热加载插件；配置 `binding: 'installation'` 设置与 `ctx.env` 密钥；以及调用任何 `'machine'` 作用域的 `defineQuery` / `defineMutation`（防止协作者借机器级查询窥探该机器上未共享项目的状态）。
- **项目协作者可调用范围：** 仅限 `'project'` 与 `'session'` 作用域的插件查询、变更与附件检索，且每次调用均实时核验 `MachineSharing` 当前同时共享了该 `machineId` 及目标引用绑定的全部项目（未绑定项目的 E2EE 普通 Session 仅限机器拥有者访问）。

### 3. 签名执行意图溯源（`e2eeIntent`）与共享成员 20 次派生上限

根据 [`e2ee-execution-intent.ts`](../../../../packages/shared/src/e2ee-execution-intent.ts)、[签名执行意图](../../implemented/architecture/2026-11-10-e2ee-signed-execution-intent.zh.md)与[共享成员派生](../../implemented/architecture/2026-10-31-e2ee-shared-member-derivation.zh.md)，E2EE 机器拒绝任何无签名授权的提示词执行：

- **前端 `useHost().sessions.create` / `send`：** 在发起用户的个人设备（`local` 桌面或已解锁 `web` 保管域）上就地对规范化提示词、附件快照及 `waitCondition` 签发 `memberInput`（`kind = 1`）。
- **机器侧 `ToolExecutionContext.host.sessions.create` / `send`：** 由守护进程签发 `machineInput`（`kind = 2`），强制携带锚定当前已验签人工根 Turn 的 `derivedFrom: { sessionId, userTurnId }`，严格继承共享成员每根 Turn **最多 20 次派生预留配额**及**禁止跨机器派生规则**（跨机直接返回 `e2ee_derivation_cross_machine_unsupported`）。
- **无人工根 Turn 的守护进程 `MachineContext`（`defineMutation` / `defineObservation`）：** 在 E2EE 工作区中调用 `sessions.create` / `send` 一律拒绝（`forbidden`），杜绝协作者借 `plugin/mutate` 或外部通过 webhook 诱导机器私钥充当无根签名预言机。
- **只读 `waitCondition` 意图绑定：** 等待态 Session 的 `waitCondition` 代码与 `params` 纳入创建者的 `memberInput`（或 `derivedFrom` `machineInput`）签名载荷，且在唤醒求值时强制禁用 `CodeMode` 的 `ctx.exec`，防止共享项目协作者借等待脚本越界执行宿主机任意 Shell 命令。

### 4. 传输分帧：256 KiB Iroh 单帧快路径与 `purpose 9` 产物分片

根据 [E2EE Iroh 传输](../../implemented/architecture/2026-11-10-e2ee-iroh-transport.zh.md)，Desktop↔Machine 直连 QUIC P2P 快路径（中位延迟约 `112 ms`，且在云端 Streams 故障期间仍可直连）仅承载单帧 `purpose 8` 请求（密文信封 `≤ 1 MiB`），超限则会退化为多信封 Streams 转发（约 `733 ms`）：

- 将 `plugin/query` 与 `plugin/mutate` 单次请求硬上限设为 **`MAX_PLUGIN_RPC_REQUEST_BYTES`（256 KiB）**，确保桌面端插件读写始终落在单个 1 MiB `purpose 8` Iroh 快路径帧内；纯浏览器 `web` 端则走标准加密 Streams RPC。
- `plugin/bundle-chunk` 直接复用既有 256 KiB `purpose 9` 只读响应分页机制（`MAX_PACKED_CLIENT_BUNDLE_BYTES` = 4 MiB，远低于 E2EE 64 页 / 16 MiB 分页上限），对 `specs/e2ee-foundations.zh.md` 零线协议改动。

### 5. 前端产物/信任保管域隔离与成员移除/设备撤销终态擦除

在 E2EE 工作区中，团队自研 `--dev` 插件或内部打包的 `client.js` 往往内含私有业务 Schema、内部系统地址与提示词模板。若仅按 `clientDigest` 明文缓存在浏览器全局 IndexedDB，不仅会在共享设备 profile 上泄露私有前端逻辑，还会在成员被移除后残留：

- E2EE 前端插件产物缓存、信任授权记录与持久化前端状态必须严格绑定 `<account>/<workspace>/<genesis>/<signing-key>` 保管域（[`specs/e2ee/client-custody.zh.md`](../../../../specs/e2ee/client-custody.zh.md)、[`specs/e2ee/desktop-custody.zh.md`](../../../../specs/e2ee/desktop-custody.zh.md)）——使用安装 KEK 或当前工作区内容密钥加密包裹，或仅在已验证解锁的内存运行期持有。
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

1. **将 `plugin/query` 纳入 `E2EE_READ_QUERY_METHODS` 开放给 `read` 访客：** 已否决。`defineQuery` 在 `PluginWorker` 中运行任意插件 Node 代码并可访问 `ctx.env` 与宿主机文件系统；向访客开放会打破「E2EE 访客只读绝不触发目标机器任意代码执行或秘密访问」的核心防线。
2. **跨工作区共用仅按 `clientDigest` 寻址的全局明文 IndexedDB 缓存：** 已否决。E2EE 团队内部开发（`--dev`）或私有打包的 `client.js` 含有敏感业务逻辑与内部接口定义，必须绑定 `<account>/<workspace>/<genesis>/<signing-key>` 保管域并在撤销或移除时可彻底擦除。
3. **允许守护进程 `defineMutation` 或 `defineObservation` 在无 `derivedFrom` 时直接签发 `machineInput`：** 已否决。若无人工根 Turn 绑定即可签发 `machineInput`，任何可调用 `plugin/mutate` 的协作者或外部 webhook 都能绕过个人设备 `memberInput` 签名与 20 次派生上限，把守护进程变成无根执行签名预言机。
4. **通过 Loro `HistoryWriter` 流式追加长耗时 `defineTool` 的中间进度：** 已否决。成百上千条中间测试进度若直接写入 Loro 文档，会造成严重的历史体积膨胀与 E2EE 内容加密帧风暴；运行态 `ToolRenderProps` 配合 `useQuery` + `ctx.invalidate` 可在零 CRDT 历史开销下实现实时进度。
5. **每个插件独占一个 OS 子进程，或在共享进程卡死时盲目封禁所有在途插件：** 已否决。每插件单开 Node 进程在多插件 `headless` 机器上会成倍放大常驻内存；而盲目封禁死循环发生时碰巧有只读请求在途的无辜插件会造成误杀。单共享 `PluginWorker` 搭配异常后的短生命周期金丝雀复现进程，兼顾了低内存开销与精准毒丸隔离。

## 影响与未决边界

- **E2EE 访客端诚实退化：** E2EE 访客可直接查看 ≤16 KiB 内联历史快照渲染的自定义工具卡片，但点击加载存放于 `sessionDataDir` 的超限详情（需调用 `useQuery`）时会诚实呈现 `{ status: 'unavailable', reason: 'forbidden' }`。
- **E2EE 全天候等待任务须由个人设备或人工根 Turn 预先布防：** E2EE 工作区的 24/7 值守 Session 须由用户在前端点击（签发含 `waitCondition` 的个人设备 `memberInput`）或在人工根 Turn 工具内（签发 `derivedFrom` `machineInput`）预先创建为 `waiting` 态，而不能在无人工根 Turn 的后台 `defineObservation` 内临时无中生有地新建 Session。
- **原生移动端渲染留白：** `apps/mobile` 暂不评估执行插件 `client.js` bundle，继续回退至宿主内置结构化视图。

## 验证范围

- [`scripts/plugin-sdk-contracts.test.mjs`](../../../../scripts/plugin-sdk-contracts.test.mjs) 在纯浏览器与纯 Node 两套隔离 TypeScript 配置下编译校验 [`sdk/shared.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/shared.d.ts)、[`sdk/client.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/client.d.ts)、[`sdk/machine.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/machine.d.ts)、[`contracts.ts`](../../../../scripts/fixtures/plugin-sdk/contracts.ts)、[`machine-contracts.ts`](../../../../scripts/fixtures/plugin-sdk/machine-contracts.ts) 及四个参考插件（`test-report`、`issue-context`、`worktrees`、`focus-sidebar`），覆盖运行态 `ToolRenderProps`、`ctx.sessionDataDir`、`MachineRef | ProjectRef` 会话创建、`businessKeyScope`、`waitCondition.params`、观察源 `revision` 与 `ctx.invalidate`、`host.panels.openSession` 及 RPC/产物字节上限常量，并对 `issue-context` 执行临时文件读写故障注入回归测试。
- 待实现验收项：`PluginHost`、`ClientPluginHost`、`PluginWorker` 金丝雀隔离、`sessionDataDir` 回收与分叉隔离、`lody plugin propose` 以及全部 E2EE RPC、`MachineSharing`、`e2eeIntent` 与保管域擦除运行时逻辑。
