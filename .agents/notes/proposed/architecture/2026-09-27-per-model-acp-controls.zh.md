# 按 model 解析 ACP 运行控件（effort / fast）

Status: proposed
Translation: current
Language: [English](2026-09-27-per-model-acp-controls.md)

## 摘要

Lody 把 `session/new` 返回的 `configOptions` 当作整个 agent 的能力目录，
按 agent config 覆盖式缓存；但 ACP agent 会在每次切换 model 时重建这组选项，
所以它只是「某一个 model」的快照。结果是 fast 与 effort 控件随上一次创建 session 时的
model 出现、消失或错位，CLI 会据此拒绝合法请求，Agent Role 的后台对账还会把这些键从存储中删掉。
本提案把 Claude / Codex 适配器已经发布、但宿主尚未读取的 `_meta.lody.modelCapabilities`
存进一条独立的 Flock 行，按「选中的 model」逐字段解析控件
（是否支持、如何编码、证据来源与新鲜度），所有消费方共用同一套解析规则。
离线目录只用于指导 UI 和给出提示，从不拒绝 effort/fast 请求。真正下发的值由 daemon 在切完 model
之后，依据 agent 的实时选项计算；Role 等存储中的偏好不再被删除。设计把同步量当作一等约束：
声明行约 1 KB、稳态零写入，用户意图从已有的 turn 历史推导，不新增存储和写入。在放宽任何校验之前，
先单独上线权限与 Plan 的执行前安全核对。尚无实现与验证。

## 问题

### 现状（基于 `main` 2e0886b8 的代码阅读）

- 缓存：机器 Flock 中每个 agent config 一行 `['acpCapability', AgentConfigId]`，
  值是 `AcpCapabilityCacheEntry`（`packages/shared/src/ai.ts`）。键中没有 model 维度。
- 写入：一次性 probe（`fetchAcpCapabilities`）和**每个新建 session**
  （`scheduleCreatedSessionCapabilityUpdate`，`session-execution-service.ts`）都用
  `session/new` 响应重建整行。后者发生在应用用户所选 model 之前，因此快照描述的是
  agent 启动时的 model；对 Codex 而言就是 `~/.codex/config.toml` 的默认 model。
  行去重用 `serializeAcpCapabilityWithoutFetchTime`（`apps/cli/src/lib/loro/doc.ts`），
  新增字段必须显式加入，否则会被当作「无变化」。
- 已有的按 model 数据只有 `modelReasoningEfforts`：来自 Codex 旧式 `model[effort]` id 的推导，
  或 Grok 适配器的 `_meta.lody.modelReasoningEfforts`。fast 没有任何按 model 的信息。
- 消费方各自处理，规则分散：
  - UI selector：`normalizeReasoningEffortSelectors`（`acp-selector-options.ts`）——Codex 用硬编码的
    `CODEX_EXTENDED_REASONING_BY_MODEL`，有映射的 agent 按 model 重建 effort，其余沿用快照。
    fast 开关是否出现完全取决于快照。
  - Composer：`resolveAcpSessionConfigSelection`（`acp-session-config-selection.ts`）在
    authoritative 分支只保留当前 selector 覆盖的键；Role 应用（`use-session-agent-role.ts`）
    和建会话前的过滤同样会丢掉没有 selector 的值。
  - Agent Role 后台对账：`reconcileAgentRoleSchema`（`agent-role-schema-reconciliation.ts`）
    在 runtime 探测后，把快照中没有的键从 Role 的持久存储里**删除**并增加 revision；
    Role 没有固定 model 时同样会删。fast/effort 因此可能在一次探测后永久丢失。
  - Schedule：`schedule-types.ts` 用快照的 `modes` / `configOptions` 做权限检查。
  - CLI：`validateTurnConfigOptionValues` 等（`apps/cli/src/commands/session.ts`）——
    快照中没有的键会被**拒绝**（`Unknown ACP config option ...: fast-mode`），
    继承来的值会被**静默丢弃**。
  - MCP：`acp-run-config.ts` 的 `measuredForModelId` / `unverifiedSelections`。
  - 运行时 applier（`acp-session-config-applier.ts`）：**先设 mode，再切 model**，最后设其他选项；
    对 Claude/Codex 抑制部分拒绝警告；成功的 `set_mode` 会把请求值当作结果写回；
    另有按名字硬编码的 `shouldSkipFableFastModeDisable`。
- 运行时已跟踪实况：`AgentClient` 在 `config_option_update` 和 `setSessionConfigOption`
  响应时替换完整选项列表；`SessionAcpRuntimeConfigSnapshot` 只记录 `id → currentValue`。

### 用户可见的后果

- PR #333 下的真实报告（2026-09-23，timonwong）：Codex 默认 model 设为 `grok-4.6` 后，
  Lody 中 Codex 的 Fast 与 Reasoning Effort 控件消失；改回 `gpt-5.6-sol` 并刷新后恢复。
- 在 composer 中切 model 时，控件仍然是快照 model 的：既可能选出目标 model 不支持的组合，
  也可能看不到目标 model 独有的控件。
- 长期可用的 Role 在默认 model 改变后被 CLI 拒绝，或者被后台对账删掉 fast/effort。
- 安全相关：Claude 切 model 时如果新 model 不支持当前 mode，会把 mode 降级为 `default`。
  由于 applier 先设 mode 再切 model，用户请求的 `plan` 可能在切 model 后变成 `default`
  （权限变宽）。而 applier 又把 `set_mode` 的请求值当作结果写回，所以这种扩大不可见。

### 已有工作

- 适配器侧已落地：`LodyAI/acp-extension-claude#24`（`94223f1`）和
  `LodyAI/acp-extension-codex#31`（`9b4c961`）在 `session/new` 响应中发布
  `_meta.lody.modelCapabilities = { version: 1, models: { [modelId]: { effortValues?, fastMode } } }`，
  两个适配器都注明它是「这个账号此刻」的建议性声明，并以 live session 状态为准。
  当前 submodule 指针已包含这两个提交，但宿主没有任何代码读取它。
- Grok 适配器发布旧的 `_meta.lody.modelReasoningEfforts`（仅 effort）。
- PR #286（已合并）引入 `modelReasoningEfforts`。PR #316、#324 已关闭，被 #333 取代。
  社区 PR #344–#346 已关闭。
- [后续对话继承目标 run config](../../implemented/bug-fix/2026-09-17-chat-follow-up-inherits-target-run-config.zh.md)：
  省略参数的后续对话会继承上一个 turn 的配置，并丢弃不兼容的继承值。本提案的 CLI 继承规则
  （第 4 节）部分取代其中「丢弃不兼容的继承值」这一点：effort/fast 改为保留意图、交给投影决定。
- [Codex GPT-6 Sol/Luna 推理档位](../../implemented/bug-fix/2026-09-24-codex-gpt6-sol-luna-reasoning.zh.md)：
  每个新 model 都要手工维护 Codex 档位表。本提案在 Codex 声明新鲜时让位于声明，这张表只作为没有声明时的回退。
- PR #333（open，+4854/−840，`mergeable=CONFLICTING`）同时包含：「快照只报告不拒绝」、
  权限扩大保护和一次性接受 UX、读取 `modelCapabilities`、UI 可用性说明。
  判断（非事实）：它的范围让评审和回滚都很困难，本提案按风险把它拆开，并复用其中的结论与测试。

## 目标与非目标

目标：

1. UI 中 effort / fast 控件按**当前选中的 model**显示正确的可用性与取值（对已声明的 agent）。
2. 离线数据（快照或声明）不再导致 effort/fast 请求被拒绝，Role 等存储中的值也不再被删除。
3. 已声明 agent 的控件可用性不再取决于最后一次快照是哪个 model。快照仍会翻转，
   但只影响描述符和标签。
4. 按 model 的规则收敛到一套共享的解析规则（展示与派发两个入口）。
5. 权限与 Plan 在执行前做安全核对，并且在放宽任何校验**之前**上线。
6. 不增加稳态同步量（第 10 节）。现有 capability 行的整行重写本提案不处理，先测量再决定。
7. 回滚任何一步都不会比这一步上线之前更差（可能回到今天的已知缺陷）。回滚有顺序约束：
   PR4 必须先于 PR1 回滚。

非目标：

- 把 plan / permission 纳入按 model 目录（它们走 PR1 的安全核对）。
- 通用的「每个 model 的完整 `configOptions`」目录（见备选方案 B）。
- 持久化运行时观察（live-observed）：不做。离线「不支持」不能从选项缺席中学习出来。
- 一次性接受更宽权限的 UX（#333 的 `acceptWiderPermissions`）：PR1 只做 fail-closed；
  是否需要这个 UX 另行决定。
- 修改 ACP 上游协议；Kimi / Pi / DeepSeek Harness 的适配器。

## 提案

### 1. 三个概念分开

| 概念 | 含义 | 存放 | 权威性 |
| --- | --- | --- | --- |
| 快照（snapshot） | 某个 model 的 `configOptions` | 现有 `acpCapability` 行 | 提供描述符与标签；只对 `currentValue` 的 model 成立 |
| 声明（declaration） | 适配器发布的每个 model 能做什么 | **新** `acpModelCapability` 行 | 建议性；指导 UI 与提示 |
| 运行时（runtime） | 某个 session 此刻的实际选项与值 | `AgentClient` / session doc | 对该 session 权威 |

快照所描述的 model 可以从快照里 `category: 'model'` 选项的 `currentValue` 读出，不需要新增字段。

### 2. 存储：独立的声明行

新 Flock 键 `['acpModelCapability', AgentConfigId]`，值：

```ts
type AcpModelCapabilityDeclaration = {
  /** 原样保存适配器声明的版本；未识别的版本整份忽略。 */
  version: 1;
  models: Record<ModelId, { effortValues?: string[]; fastMode?: boolean }>;
  /** 必填：与现有 capability 行相同的来源版本计算（getAcpCapabilitySourceVersion）。 */
  sourceVersion: string;
};
```

值里**不放任何时间戳或计数器**。行值每变一次就要同步给整个 workspace 的所有客户端，
而 probe 非常频繁（见第 10 节）：只要值里有随每次 probe 变化的字段，就会把「内容没变」变成一次写入和同步。

为什么不在现有行里加字段：

- 现有行由 probe 与每个新 session 整行重建；旧版本 daemon 或降级后的 daemon 重建时会把新字段清掉。
  独立行只由新代码写，旧代码不认识这个键，也不会触碰它。
- `AcpCapabilityCacheEntrySchema` 是 `.strict()`，用于 `machine/acp-capabilities-refresh_response`。
  新字段放进这个响应会让旧客户端整个解析失败。独立行不进入这个响应，新数据只经由 Flock 读取。
- 旧读者对未知的 Flock 行类型返回 `undefined` 并忽略（`machine-flock.ts` 的行解析），已核实。
- 生命周期不同：声明描述整个 model 目录；快照只描述一个 model。
- 同步量：独立行约 1 KB，而现有行 4–40 KB（Devin 177 KB）。声明变化时只同步这 1 KB，不会牵动大行。

写入规则（刻意保持简单，因为声明**只影响 UI 和提示，不参与派发**，见第 4 节）：

- 收到 v1 声明（probe 或 session/new）时，与已存值比较**整个值**；相同就不写，不同就覆盖。
  稳态下写入次数为零。
- 没有收到声明时**不删除**已有声明行：适配器某次没带声明，不等于能力消失。
- agent config 被删除时一并删除。
- `sourceVersion` 与当前 agent config 计算出的值不一致时，解析直接视为没有声明，不需要删除。
- **写入序号防护，放在 daemon 内存中**，不产生任何 Flock 写入：daemon 为每个 agent config 维护一个
  单调递增的请求序号。每次 probe 或 session/new **发起时**取一个新序号；认证开始、`authenticationRequired`
  与 agent config 删除时也递增。写入时，只有当它的序号大于该 config 最后一次成功写入的序号，
  并且大于最近一次失效序号时才写。这样既挡住同一认证期内 probe A 晚于 probe B 写回，
  也挡住认证之后写回旧声明。
- **不做基于时间的 TTL，并明确接受它的代价**：
  - 远端的 web / 移动客户端只能看到同步过去的值，时间戳只能放进同步值；Flock 的读取接口也不暴露行的写入时间；
  - 若只在内容变化时写 `changedAt`，还需要一套按需 RPC 与客户端暂存才能在过期后刷新，与收益不相称。
  - 代价：没有时间上界。远端 UI 可能长期显示过时的建议，例如在 Lody 之外换了账号或权益，
    这台机器又一直没有带回声明的 probe 或新建 session。
  - 这个代价只落在显示上：派发只看 live；一个 turn 跑完之后，控件是否可用以该 session 的 live 状态为准；
    `sourceVersion` 变化（适配器或运行时升级）会让旧声明失效。
- legacy 来源（Codex 旧 id、Grok `_meta`）**不**写入这一行，仍保留在现有行中，读取时再计算。

**快照稳定化不做**：曾考虑在新建 session 只是当前 model 不同时不改写 `configOptions`，以减少整行重写。
后来对内置 Claude 与 Codex 在四个目录下实测 probe，除 `availableCommands` 外的所有字段（包括每个
`currentValue`）都逐字节一致；整行重写的来源是项目级命令，已由
[项目斜杠命令差异行](../../implemented/architecture/2026-09-27-acp-command-scope-rows.zh.md)处理。

### 3. 共享解析：逐字段，分开「是否支持」和「如何编码」

`packages/shared` 中有两个入口，共用同一套控件识别与绑定规则：

- `resolveModelControls`：给 UI、预检、提示用，可以使用离线数据；
- `projectDispatchControls`：给 daemon 派发用（第 4 节），**没有离线回退**，只接受带来源证明的 live 证据。

展示入口的签名：

```ts
type Evidence = 'declared' | 'legacy-derived' | 'snapshot' | 'live';
type Support<T> =
  | { state: 'supported'; value: T; evidence: Evidence }
  | { state: 'unsupported'; evidence: Evidence }
  | { state: 'unknown' };
type Binding =
  | { state: 'bound'; configId: string; encoding: 'boolean' | 'on-off-select' | 'select' }
  | { state: 'unbound' };            // 知道支持，但不知道如何发给这个 agent

resolveModelControls(input: {
  snapshot?: AcpCapabilityCacheEntry;
  declaration?: AcpModelCapabilityDeclaration;
  /** 按当前 agent config 计算的来源版本；与声明不一致时声明视为不存在。 */
  expectedSourceVersion: string;
  /** 运行时的 live configOptions；存在时优先于一切离线数据。 */
  live?: { modelId: string; configOptions: AcpConfigOptionSummary[] };
  agent: { cliType; agentType };
  modelId: string | null;
}): {
  effort: { support: Support<string[]>; binding: Binding };
  fast: { support: Support<true>; binding: Binding };
};
```

- 支持判断按字段取：`live`（仅当 `modelId` 等于 live model）> `declared`（`sourceVersion` 匹配）>
  `legacy-derived`（仅 effort）> `snapshot`（仅当 `modelId` 等于快照 model）> `unknown`。
  同一个 model 可以 fast 已声明、effort 来自 legacy。
- 绑定（configId 与编码）：
  1. live 或快照中同语义的选项（按 `isAcpFastModeConfigId` / `isAcpThoughtLevelConfigOption`），
     编码取自它的 `type`：boolean，或选项值为 on/off 的 select；
  2. 否则，仅对**已知的内置适配器**查绑定表（Codex `fast-mode`、Claude `fast`，以及 effort 的 id）。
     Lody 的 `initialize` 固定声明支持 boolean config option（`agent-client.ts`），
     两个适配器据此发布 boolean fast；绑定表记录的就是这个编码，并用契约测试钉住。
     自定义或被覆盖的运行时不查表；
  3. 都没有就是 `unbound`：UI 不渲染这个控件，但存储中的值不被视为无效，也不会被删除。
- **渲染成本约束**：composer 在流式输出时，session doc 的合并每秒会重建好几次。
  `resolveModelControls` 必须按（快照、声明、modelId、live 列表）的引用做记忆化，
  输入不变时返回同一个对象，否则 selector 与 composer 子树会每帧重建。

### 4. 本轮投影，以及意图由谁保存

每个 turn 都会调用 applier，但它只遍历本轮 `inputConfig.configOptionValues` 中出现的键
（`session-dispatch-watcher.ts`）。这张表可以是稀疏的。另一方面，Claude 与 Codex 适配器在不支持 fast 的
model 上都会**保留** fast 意图：选项重新出现时，它的 `currentValue` 就是保留下来的值
（Codex `createFastModeConfigOption(fastModeEnabled)`，`FastModeConfig.ts`；Claude 同理）。
Codex 在发 prompt 时按「保留的开关 × 实际 model 是否支持」决定速度。所以「省略 fast」不等于「关闭 fast」。

**投影**在 **daemon 的 applier 内、切完 model 之后**计算本轮实际下发的值。applier 先切 model，
`setSessionConfigOption` 的响应会让 `AgentClient` 用目标 model 的 **live** `configOptions` 替换本地状态
（`applyConfigOptionsState`）。于是投影几乎总是基于 live 证据，离线声明**不参与派发决策**。

证据接口：model 切换（以及没有切换时的当前状态）必须产出带来源证明的结果，而不是只读
`getConfigOptions()` 这个数组：

```ts
type LiveControlEvidence = {
  /** 只有 agent 原始发来的完整列表才算：set 响应的 configOptions、config_option_update、
   *  session/new|load|resume 响应。客户端的乐观补值（retainLegacyConfigOptionValue）
   *  和空回执都不算。 */
  source: 'set-response' | 'config-option-update' | 'session-response';
  /** 该列表中 category:'model' 的 currentValue。 */
  reportedModelId: string;
  configOptions: AcpConfigOptionSummary[];
  /** 单调递增；晚于本轮最后一次 model 设置请求才有效。 */
  generation: number;
};
```

能凭「列表中没有该控件」推出 unsupported 的，只有两种情形：

1. 本轮切换了 model：只认**这次** model 设置请求的同步完整响应（`source: 'set-response'`），
   而且其中的 `reportedModelId` 必须等于目标 model；
2. 本轮没有切换 model：使用**同步确认**的 session 基线，也就是最近一份来自同步响应
   （session/new|load|resume 响应或 set 响应）、并且 `reportedModelId` 等于当前 model 的原始完整列表。
   异步通知不能成为这个基线。

`config_option_update` 是异步通知，不带对应设置请求的 id，一条旧通知可能在新请求之后才到达。
所以它可以更新展示，也可以证明某个控件**存在**，但不能凭缺席让派发跳过。
空回执、legacy `session/set_model`（只改 `currentModel`，不刷新列表）、报告的 model 与请求不一致，
也一律按 unknown 处理，即照常下发。同时修正：set 响应已经报告了实际 model 时，
不再用请求值覆盖 `currentModel`。

投影规则：

- live 中有该控件 → 下发请求值，**包括 `false`**；
- live 中明确没有该控件（按上面的条件）→ 本轮不下发，记为「已跳过」；
- 没有满足条件的证据 → 下发，由 agent 确认或拒绝；
- 语义参数（MCP 的 `fastMode` / `reasoningEffort`）无法绑定到 configId 时 → 报告「无法投影」，
  不声称已下发。

**意图由谁保存**：意图**从已有的 turn 历史中推导**，不新增存储，不新增写入，也不改变 turn 的记录语义。

- 为什么需要持久意图，而不能只靠适配器回显：
  - 适配器只能回显它**收到过**的值。Role 在不支持 fast 的 model 上新建 session 时，今天首轮根本没有把 fast
    交给适配器；之后切到支持的 model，适配器回显的是它自己的初始状态，而不是 Role 的值；
  - 切 model 发送之前，agent 还没有报告新 model 的状态，开关显示的是默认值，与之后实际生效的保留值不一致。
- **turn 继续整表记录**：turn 的 `inputConfig` 表示「本轮**请求**的选择」，其中可能包含当前 model 不支持、
  因而没有下发的意图键。考虑过「只记录显式设置的稀疏表」，但它会波及大量读写方：新会话的本地默认值、
  冻结 Operation、CLI 继承、执行按钮、最近使用配置、Role 创建、Schedule 提案、历史详情。所以不采纳（备选方案 J）。
- 新增纯函数 `resolveSessionControlIntent(history, queue, uptoUserTurnId)`，与第 6 节的
  `resolveSessionSafetyIntent` 同一族：
  - 走 session-data 的目录读，只读取到指定的 turn 为止；
  - effort 与 fast **逐字段**向前寻找最近一个携带该键的 turn，显式的 `false` 保留；
  - 长对话：按 session 缓存上一次的解析结果，以历史目录版本作为缓存键，只增量处理新增的 turn。
- 历史顺序就是派发顺序，所以「最新的请求胜出」对多个客户端和 daemon 重启都天然成立。
- **effort/fast 的优先级：用户编辑 > 历史意图 > runtime > 默认值**（其他键仍是今天的
  「编辑 > runtime > turn 偏好 > 默认」）。runtime **不能**覆盖持久意图，原因是 runtime 可能在没有应用本轮值的情况下被更新：
  - turn 结束后，daemon 仍以它作为迟到 ACP 通知的归属目标；空闲时收到的 `config_option_update`
    也会被写成这个 turn 的 runtime 补丁，而 `applyAcpRuntimeConfigPatch` 只核对「是否为最新 user turn」；
  - 通知也可能迟到到下一个 turn 接管之后。

  runtime 在 UI 中称为「agent 最近报告的状态」（迟到的通知未必代表此刻的状态），用于：
  - 在它与意图不一致时给出提示，例如「agent 最近报告为关闭，下次发送将恢复为开启」，
    并提供「采用 agent 最近报告的值」的操作，点一下即成为新的意图。这也覆盖了用户通过 agent 自己的斜杠命令
    切换 fast 的情形：Lody 以历史意图为准，但不会悄悄覆盖；
  - 投影时的「已跳过 / 被拒绝」提示。
- **本地历史导入**（`local-project-history-sync-service.ts`）：导入继续**只更新 runtime**，不写意图。
  导入的 runtime 来自新连接上 `loadSession` 重建的状态，没有「用户显式选择」的来源信息：
  Claude 的 fast 来自 SDK 当时的状态，effort 可能来自设置或默认值；Codex 的历史读取路径甚至不返回 runtime。
  此外，导入只追加 turn，源会话只改了配置、没有新消息时，也没有现成的写入路径。因此：
  - 没有 Lody 历史意图时，runtime 按优先级自然成为显示值与发送值，首次从 Lody 发送时写进 turn，成为意图；
  - 已有 Lody 意图时，按上面的提示显示差异，由用户决定是否采用。
- 使用方：
  - **daemon 投影**：本轮值 = 本轮 `inputConfig` 中的值；没有就取
    `resolveSessionControlIntent(…, 本轮)`。live 支持该控件时下发意图值；**只有**当本轮有可信的同步确认
    （与判断缺席同一条证据规则：本次 model 设置的同步完整响应，或同步确认的 session 基线），
    并且其中的值已经等于意图时，才省略这次 RPC。异步通知更新的 `currentValue` 既不能用来判断缺席，
    也不能用来判断相等。反过来，同步基线之后只要收到任何**相反**的异步报告，这份基线对该控件的
    等值证明就失效（与第 6 节「相反报告使确认失效」同一原则），本轮必须下发意图值；
  - **原生 steer**：`configPolicy: 'active'` 的比较改用同样的「本轮值，否则历史意图」。
    不一致时沿用今天的行为，拒绝 steer 并转为普通排队 turn，由普通派发走投影；
  - **composer**：只改两处——
    1. effort/fast 的历史意图作为输入，在未校验候选与最终选择**之前**合入同一份按值稳定的偏好，
       不在最终选择之后反向修改候选；
    2. authoritative 分支对 effort/fast **不因当前 model 没有可见 selector 而丢弃**：
       键保留在最终表中，标为「本 model 不支持，发送时跳过」；
  - **应用 Role 与各建会话入口**（Chat Landing、Draft、现有会话中应用 Role、最近使用配置回放）：
    Role 或本地默认值属于「用户编辑」这一级的输入，在最终选择之前合入；之后的过滤对 effort/fast 不再丢弃不可见的键。
    门控放在**形成最终派发值的每一个入口**；
  - **CLI 后续对话继承、Schedule 提案（展示与创建）、冻结 Operation**：CLI/MCP 的 turn 可能不带某个键，
    所以不能再假设「最近 turn 带完整表」。effort/fast 改为按字段用
    `resolveSessionControlIntent(…, 准确的 source turn)` 解析。冻结 Operation 在**接受时**把解析结果写进每个目标配置，
    重放时直接使用冻结值，不重新读取可能已经变化的父会话历史。
- **混合版本**：新 daemon 在 `MachineMeta.protocolCapabilities` 中声明 `acpTurnControlProjection`。
  只有目标 daemon 声明了它，UI 才保留不可见的 effort/fast 键、才使用历史意图作为 turn 偏好；
  对旧 daemon 保持今天的行为。这个能力位在注册时写一次，不产生持续同步。
- **同步量**：没有新增写入次数。只有当前 model 不支持 effort/fast、却仍保留意图时，
  队列与历史两处的 `inputConfig` 才会多几个键。

配套修改：

- **CLI 继承**：显式切 model 时，不再丢弃继承表中的 effort/fast 键，交给投影决定。
- **「已跳过」和运行时拒绝的记录**：把 skipped / rejected 键写进
  `SessionAcpRuntimeConfigSnapshot`，UI 从这里渲染提示，承诺只到「最新 turn 的尽力提示」：
  - 这份快照整个 session 只有一份，下一个 turn 会替换它；
  - 目标已不是最新 turn 时，写入返回 `false`，不写；
  - 它不是安全字段，所以**不阻塞 prompt**；
  - 实施时要把新字段加入 schema、合并逻辑和 `acpRuntimeConfigEqual`；
  - 写入失败的日志提升到 warn。

  这些字段必须**并入 applier 本来就返回的那次 runtime patch**，与它一起写入；
  不能单独再写一次，否则每个 turn 会多一次 session doc 写入并递增 revision。
- **承诺边界**：投影只保证发送前 agent 所在的 model。agent 可以在 turn 内自行换 model
  （例如 Claude 在拒绝后回退到另一个 model），这时被跳过的值不会生效。提示文字只能说「本轮发送时已跳过」。
- **运行时核对**：投影后读取 agent 报告的最终 `configOptions`，与投影逐项对比，不一致就给出可见警告，
  包括现在对 Claude/Codex 抑制的那部分。

需要测试钉住的状态转换：

- fast 开启（支持）→ 切到不支持（跳过）→ 意图改为关闭 → 切回支持（下发 `false`，fast 实际关闭）；
- 一个 CLI 后续对话没有携带 fast，而 load 后适配器默认关闭、历史意图为开启 → daemon 下发开启；
- 空闲时迟到的 `config_option_update` 报告 fast 关闭、历史意图为开启 → composer 显示开启（并提示实际状态不同），
  下一轮下发开启；
- steer 时 agent 的 fast 与历史意图不一致 → steer 被拒并转为普通 turn，由投影补上；
- 从 Lody 之外导入的历史带来 fast 关闭：没有 Lody 意图时显示并发送关闭；已有开启的意图时显示差异提示，
  「采用 agent 最近报告的值」之后才变为关闭；
- 迟到的异步通知把 `currentValue` 改成与意图相同 → 投影仍下发意图值，不省略；
- 同步基线为 fast 开启，之后 agent 异步报告关闭，同一 model 上的下一轮、意图仍为开启 →
  基线的等值证明失效，下发开启；
- 在不支持 fast 的 model 上，composer 的整表仍然携带意图键（新 daemon），投影跳过它；
- Role 固定 `fast=true`，在不支持 fast 的 model 上新建 session → 切到支持的 model →
  fast 按 Role 的值生效；
- 两个客户端先后显式设置不同的 fast 值 → 以历史中较新的那个为准；
- daemon 重启后，意图仍从历史中恢复。

### 5. 各消费方

| 消费方 | supported | unsupported | unknown | unbound |
| --- | --- | --- | --- | --- |
| UI selector（composer、移动端、Role 与 Schedule 编辑） | 按 model 渲染 | 隐藏；Role / Schedule 编辑中若有存储值，提示「当前 model 不支持，发送时跳过」 | 今天基于快照的渲染 | 不渲染 |
| Composer / 建会话 / Role 应用 / 最近配置回放 | 校验取值；优先级「编辑 > 历史意图 > runtime > 默认」 | 保留意图键（仅新 daemon） | 保留意图键（仅新 daemon） | 保留意图键（仅新 daemon） |
| CLI 继承 / Schedule 提案 / 冻结 Operation | 按字段解析历史意图，精确到 source turn；Operation 在接受时冻结 | 同左 | 同左 | 同左 |
| Role「是否已应用」的比较（`composer-agent-roles.ts`） | 比较 | **忽略**该键，不因此把 Role 显示为未应用 | 同今天 | 忽略 |
| Agent Role 后台对账 | — | **不删除** effort/fast 键 | 不删除 | 不删除 |
| CLI / MCP 预检 | 取值不在声明中时提示 | 不拒绝；提示 | 不拒绝 | 语义参数：报告无法投影 |
| daemon 投影 | 见第 4 节，只看 live | | | |

- composer 的改动限定在第 4 节的两处（effort/fast 以历史意图为输入并优先于 runtime；不丢弃不可见的键），
  其余键的推导（包括 runtime 表独占这些键）不变。它仍是纯推导，不会重新引入 React #185 那种 effect 振荡；
  PR4 要为这片区域补上针对性的回归测试。
- Role 与冻结 Operation 的 effort/fast 不一致不会阻止执行，只给出提示：它们是偏好，
  升级不能让原本能跑的 Role 失败。安全字段不适用这条规则，见第 6 节。
- `reconcileAgentRoleSchema` 改为：effort/fast 这类按 model 变化的键永不因快照删除。
  这改变了 [Role 对账 Spec](../../../../specs/agent-role-schema-reconciliation.md) 的意图，
  需要同步修改该 Spec（它现在是 draft）。附带澄清：Spec 要求「Role 固定的 model 与 probe 的 model
  一致」才删除，而实现把未固定 model 的 Role 视为一致，这一处也在同一次修改中对齐。
  这也减少了同步：每次删除都要写 Role 行、增加 revision 并上传 catalog。
- CLI 预检只拒绝类型层面不可能的值（例如给 boolean 选项传字符串）；其余只提示。

### 6. 安全前置：权限与 Plan 的执行前核对（PR1，独立上线）

- applier 顺序改为：model → effort/fast 等普通选项 → permission mode 与 Plan **最后**设置。
- **本轮的有效安全意图**：turn 配置是稀疏的，而 `resolveSessionConversationConfig` 只看最新 turn，
  所以需要一个新的纯函数 `resolveSessionSafetyIntent(history, queue, currentUserTurnId)`，
  **按字段、限定到正在执行的 turn** 解析：
  - 只读取到 `currentUserTurnId` 为止，不读更晚的内容。现有的来源收集会把所有队列项排在历史之前，
    不加这个限定，就可能把后面排队的 turn 的安全意图用到当前 turn 上；
  - permission mode 与 Plan 是两个独立字段（Core 明确规定 Plan 与权限无关），分别向前寻找
    最近一个显式携带该字段的 turn。`plan_mode` 和旧的 `collaboration_mode` 归为同一个 Plan 字段；
    显式的 `false` 要保留，它表示关闭，不等于没有设置；
  - 读的是 session doc 中的持久历史，进程重启后照样成立；必须走目录读，见第 10 节；
  - 显式选择非受限 mode，只清除 mode 字段上的受限意图；关闭 Plan 只清除 Plan。
    两个字段都没有找到时，没有安全意图，不核对。
- **重新设置**：本轮切换了 model，而安全意图来自继承时，applier 在最后**重新下发**这个继承的
  mode / Plan，再按下表核对。新 model 不支持时，设置失败 → fail closed，这是正确结果。
- **原始报告与乐观值**：只有 agent 原始发来的状态才算证据；`retainLegacyConfigOptionValue`
  这类客户端补值，以及 `set_config_option` 的空响应，都不算。
- **证据的方向**（与第 4 节的派发规则同一原则：异步通知没有请求 id，无法与某次设置关联）：
  - **正面确认**：本轮新设置的受限 mode / Plan，只能由**这次设置**的同步完整响应
    （set 响应中的 `configOptions`），或者真正发出并成功返回的 `session/set_mode` 确认；
  - **异步通知**（`current_mode_update`、`config_option_update`）只能**否定**确认，
    不能单独补出确认。例如一条旧的 `plan` 通知在新请求之后才到达，不能把一次空回执或实际发生的降级
    误判为成功；
  - 前一个 turn 已经同步确认、本轮没有重设的状态可以继承，但之后任何相反的报告都会让它失效；
  - `session/new` 以及本轮设置之前的报告都不算本轮的确认。
- 安全要求按「请求」定义，不依赖 UI 的显示分类（`classifyPermissionModeFace` 只决定按钮怎么显示，
  不是权限顺序）：
  - 新增一张**按 agent 定义的权限关系表**，只覆盖内置 agent，例如 Claude：
    `plan` < `default` < `acceptEdits` < `bypassPermissions`；Codex 的对应关系在实现时从适配器核实。
    表中标出哪些 mode 是「受限」的（只读或 Plan）。内置 agent 出现表外的新 mode，按「无法比较」处理，
    不当作第三方。
  - 独立的 Plan 选项（Core `plan_mode`，以及旧的 `collaboration_mode`）单独核对。
- prompt 之前的判定。mode 与 Plan 同时存在时，两个字段**各自**通过核对；「按表更窄」只适用于 mode。
  表中的「确认」只指上面定义的正面确认：本次设置的同步完整响应，或者前一 turn 同步确认、
  且没有被相反报告否定的状态。

  | 有效安全意图 | 设置后的证据 | 结果 |
  | --- | --- | --- |
  | 受限 mode 或 Plan 开启 | 确认等于请求；对 mode 而言，按表更窄也算 | 放行 |
  | 受限 mode 或 Plan 开启 | 确认为其他值、无法比较，或者之后收到相反的报告 | **fail closed** |
  | 受限 mode | 没有同步响应，但 `session/set_mode` 真正成功返回 | 见下文 |
  | 受限 mode 或 Plan 开启 | `set_config_option` 成功，但只返回空响应 | **fail closed** |
  | 受限 mode 或 Plan 开启 | 设置请求失败 | **fail closed** |
  | 非受限 mode | 报告按表更宽 | **fail closed** |
  | 非受限 mode | 报告更窄、无法比较（第三方），或者没有报告 | 放行，给出可见警告 |
  | 非受限 mode | 设置请求失败 | 放行，给出可见警告（与今天一致） |
  | 无 | — | 不核对 |

- 「没有设置后的报告，只有 `set_mode` 同步成功」怎么处理：mode 现在是**最后**设置的，之后本轮不再有
  会改变 mode 的操作，所以成功回执是 agent 对最新请求的确认。旧的 stale 问题来自「mode 先设、
  model 后切」，调整顺序后已不存在。因此：
  - 对已核实版本的内置适配器（例如 Codex 的 `setSessionMode` 只返回 `{}`、不推送更新），接受回执；
  - 对第三方 agent：接受回执，并给出「没有独立状态报告」的提示。ACP 把 `session/set_mode`
    定义为设置操作，并不要求 agent 在设置后再发通知；通知是给 agent 自行改变 mode 用的。
    前提是 Lody 确实发出了这个 RPC 并收到成功返回，之后没有相反的报告。
- **「受限」由谁定义**：只有内置 agent 的权限表，以及 Lody 自己定义语义的 Core `plan_mode`
  可以把一个请求标为受限。第三方 mode 的 id 和说明没有通用的只读语义，
  所以即使叫 `plan`，也只按非受限、无法比较处理，产品也不能对它承诺只读。
- 失败信息写明请求值、实际值和 model。Role 与 Schedule 的失败要指向可以修改配置后重跑的入口，
  不自动以同一配置重试。
- 不提供一次性接受 UX。关闭 #333 时，把「一次性接受更宽权限」记为未被本系列取代、有待决定的事项。

### 7. 上线顺序

1. **PR1 安全前置**（第 6 节）。在 PR4 上线之前，回滚它只会恢复现状；**PR4 上线之后，
   不能单独回滚 PR1**，要回滚就必须先回滚 PR4。
2. **PR2 读者与解析**：注册新的 Flock 行类型及其宽容解析，`resolveModelControls` 和投影函数入库，
   附测试；暂无消费方，没有行为变化。
3. **PR3 生产者**：CLI 解析 `_meta.lody.modelCapabilities` v1，按第 2 节写入声明行
   （整值去重、内存中的写入序号防护）。refresh 响应保持原形。不 bump `ACP_CAPABILITY_CACHE_VERSION`：
   现有行的格式没有变。capability 行写入的字段级日志已随项目命令差异行一起落地。
4. **PR4 消费方切换**：第 4、5 节的全部内容，包括 daemon 投影与历史意图、`acpTurnControlProjection` 能力、
   composer 的两处改动与各建会话入口、CLI 继承 / Schedule 提案 / 冻结 Operation 的按字段解析、UI 按 model 渲染、
   Role 对账与已应用比较、CLI、MCP、runtime 快照中的「已跳过」字段。删除 Fable 特判；
   Codex 声明存在时让位于声明，硬编码档位只在没有声明时使用；同步修改 Role 对账 Spec 和 components 约束。
5. 后续：Grok 改为发布 `modelCapabilities`；声明 v2 可以带 agent 级绑定，从而退役宿主绑定表；
   #333 在本系列合入后关闭，并注明取代关系。

回滚语义：

- PR3 可以单独回滚：声明行不再更新。
- PR4 可以单独回滚，回到**今天的行为，连同今天的缺陷**：旧 daemon 按今天的 applier 处理 `inputConfig`
  （包括跳过 Fable 的部分 `fast=false`、抑制部分警告）；旧的 Role 对账可能再次删掉 fast/effort；
  旧 CLI 预检可能再次拒绝。这些都不比 PR4 上线之前更差。PR4 没有改变 `inputConfig` 的形状，
  只是可能多带当前 model 不支持的 effort/fast 键；旧 daemon 会照常下发，被 agent 拒绝就按今天的方式处理
  （可能给出警告，也可能被抑制）。所以队列中尚未派发的 turn 不需要排空。
- UI 看不到 `acpTurnControlProjection` 能力时（包括 daemon 降级），会自动回到今天的过滤行为。
- 顺序约束：PR4 上线之后要回滚 PR1，必须先回滚 PR4。

### 8. Spec 与约束

- PR1 起草 `specs/acp-run-config-safety.md`（draft）：权限与 Plan 的执行前核对规则。
- PR2 起草 `specs/acp-model-controls.md`（draft）：三个概念、意图与投影、
  「离线数据不拒绝 effort/fast，也不删除存储」、「未声明即未知」。
- PR4 修改 `specs/agent-role-schema-reconciliation.md`（保持 draft）。
- 在 `packages/shared/AGENTS.md` 与 `packages/components/src/lib/AGENTS.md` 中各加一行约束并链接。
  两个文件都已接近 8 KiB 的门限（目前分别只剩约 66 与 28 字节），加约束之前要先按
  [内容归属](../../../README.md#where-content-goes)把已有的某个主题移出去。

### 9. 实施风险最高的一处与验证方式

风险最高的是 **`AgentClient` 到 applier 之间的证据来源判定**：哪条消息能证明什么（正面确认还是否定），
以及能不能凭缺席跳过。它同时决定安全核对是否会误放行，以及投影是否会误跳过。

验证（遵循仓库的测试约束：显式信号、确定性夹具、不依赖真实时序）：

- **ACP 消息边界的确定性契约测试**：用假的 ACP 连接控制消息顺序，把旧的 `plan` 通知或控件通知
  延迟到新设置响应**之后**才送达，分别断言：
  - 受限请求不会因此放行；
  - fast 不会因通知中缺少它而被跳过；
  - 空回执、legacy `set_model`、报告的 model 与请求不一致这三种情形，都落入 unknown；
  - 受限请求遇到 `set_config_option` 只返回空响应时 fail closed；
  - 前一 turn 已确认的受限状态，在收到相反通知后失效。
- **状态转换测试**：第 4 节列出的全部状态转换。
- **同步测试**：同一份声明重复到达不产生 Flock 写入；「已跳过」字段不产生额外的 runtime 快照写入；
  Role 对账不再因 effort/fast 写 Role 行。
- **固定版本真实适配器的 e2e**（沿用 #333 的 `acp-runtime-contract.e2e` 思路）：用当前 submodule 版本的
  Claude / Codex 适配器跑以下流程，核对 prompt 之前的实际状态：
  - model 切换；
  - Claude 切 model 导致 mode 降级；
  - Codex `set_mode` 返回空回执；
  - 两个适配器的 `modelCapabilities` 声明形状、boolean 编码，以及选项重新出现时对保留值的回显。

  这些测试需要账号，大概率只能在本地运行，在 CI 中主要依靠契约测试（合成夹具）。
- 以上都是计划中的验证，本提案阶段尚未执行。

### 10. 成本

以下运行时与同步数字来自一台开发机 2026-09-25 至 27 的 daemon 日志和 `lody machine list --include-acp-capabilities`，
只是一个样本，不代表所有用户。

**运行时**

- 现在应用一次 run config：Codex p50 18ms / p90 92ms，Claude p50 65ms / p90 161ms，
  每次约 6 个 RPC（96 次应用）。96 次中有 84 次本来就带 fast 键。
- 投影与安全核对都是内存计算。可能新增的 RPC 有两类，每个约 3–10ms：
  - 「本轮切了 model、且安全意图来自继承」时，重发一次 mode；
  - 历史意图与 live 当前值不同、而本轮没有带这个键时，补发一次 effort 或 fast。

  只有同步确认的值已经等于意图时才省略 RPC，所以大多数 turn 仍会下发 effort/fast，与今天相当
  （样本中 96 次有 84 次带 fast 键）。总 RPC 数预计与今天持平，可能略增（未测量）。
  RPC 本身不写 Flock，但补发之后 agent 的 `config_option_update` 可能触发额外的 session runtime patch，
  使 revision 递增。这是同步成本上**唯一需要在实施中盯住的一点**：PR4 按 turn 记录 runtime patch 的
  实际写入次数与字节，用来验证。
- `resolveSessionSafetyIntent` 必须走 session-data 的**目录读**（包含 input config、不含正文、
  解析有缓存），不能用 `readAll` / `readSessionHistory`，否则长对话会把所有正文实例化。

**同步**（Flock 行的值每变一次，就要同步给 workspace 内的所有客户端）

- 现有 capability 行是整行写入：Claude / Codex 4–40 KB（主要是 `availableCommands`），Devin 177 KB。
  样本 workspace 中 10 台机器的 capability 行合计约 700 KB。
- 样本中 probe 很频繁：09-25 每个 agent 约 124–149 次刷新请求，实际发生了 207 次整行写入
  （不同内容才写）；09-26 为 84 次，09-27 为 30 次。
  实测 probe 表明，这些写入来自 `availableCommands` 随工作目录变化，而不是快照 model 翻转；
  已由[项目斜杠命令差异行](../../implemented/architecture/2026-09-27-acp-command-scope-rows.zh.md)处理。
- 本提案的同步影响：
  - 新声明行：每行约 1 KB，值中没有时间戳，内容不变时写入为零。首次发布、以及内容改变
    （新 model、权益变化、适配器升级）时，会同步给**所有现有客户端**；新客户端在首次同步时付出全部。
    样本 workspace 约 20 行，合计约 20 KB。写入序号防护只在内存中；
  - Role 对账不再删除 effort/fast：减少 Role 行写入、revision 递增和 catalog 上传；
  - runtime 快照新增的「已跳过」键：并入已有的那次 patch，只多几十字节；
  - 意图从已有 turn 历史推导：没有新增写入次数；只在「model 不支持但保留意图」时，
    队列与历史中多几个键；
  - `acpTurnControlProjection` 能力位：注册时写一次。
  - 快照稳定化不做：实测没有可节省的写入。

**工程量**（参照 #333 的逐文件 diff 估算）

| PR | 生产代码 | 测试 |
| --- | --- | --- |
| PR1 安全前置 | ~400–600 | ~600–900（含 e2e） |
| PR2 读者与解析 | ~200 | ~250 |
| PR3 生产者 | ~100 | ~150 |
| PR4 消费方 | ~500–800 | ~600–900 |

合计约 2.8–3.8k 行，#333 是 +4854。相对最初一版的主要削减：去掉基于时间的 TTL 和值中的时间戳，
意图从已有历史推导，不新增存储。风险最高的部分仍是 PR1，它不能省。

## 备选方案

- **A. 维持现状并继续加特判**（Fable、Codex 档位）：每个新 model 都要改代码，快照翻转问题仍在。不采纳。
- **B. 每个 model 存完整 `configOptions`**：通用，但要么 probe 时逐个切换 model（慢，还会触发账号侧行为），
  要么要求适配器发布全部描述符（Flock 行体积随 model 数 × 选项数增长，并同步给所有客户端）。
  等出现 effort/fast 之外确实按 model 变化的非安全控件时，再用声明 v2 扩展。
- **C. 只靠运行时**：UI 无法在发送前显示正确的控件。不采纳。
- **D. 在现有 capability 行里加 `modelControls` 字段**（本提案初稿）：会被旧写者整行覆盖，
  还会撞上严格的 RPC schema。改为独立行（Codex 评审提出）。
- **E. 不支持时改为下发 `fast=false`，不做意图与投影**：适配器在 model 不支持时通常不暴露这个选项，
  下发会被拒绝（Fable 特判就是这种情况的补丁），而且会把用户的意图改写掉。不采纳。
- **F. 整体合并 #333**：功能最全，但它把安全修复和目录读取捆在一起，评审和回滚成本高。
- **G. 只靠适配器回显，再加 daemon 内存补发表来保存意图**（成本削减过程中的一版）：
  适配器只能回显它收到过的值，Role 首轮被过滤的意图因此永久丢失；内存表还需要额外的覆盖规则，
  并且在重启后丢失。改为从已有 turn 历史推导：同样没有新增写入，而且天然有序、持久。
- **H. 在声明值中加时间戳，做基于时间的 TTL**：远端客户端只能看到同步值，时间戳只能放进同步值，
  每次确认都会变成一次写入。改为不设时间上界，明确接受远端显示可能长期过时（只影响显示），
  写入序号防护放在内存中。
- **I. 快照稳定化**：判定边界不清；实测 `configOptions` 在不同目录下从未变化，没有可节省的写入。不采纳。
- **J. effort/fast 在 turn 中只记录显式设置（稀疏记录）**：它能让「turn 携带的键」严格等于「显式意图」，
  但要改动新会话的本地默认值、冻结 Operation、CLI 继承、执行按钮、最近使用配置、Role 创建、
  Schedule 提案和历史详情。改为整表记录「本轮请求」，并规定 effort/fast 的历史意图优先于 runtime，
  改动面小得多，所以不采纳。
## 评审状态

方案与 Codex 进行了十四轮交叉评审，每一条都对照代码核实，最终结论为「认可」：

- 前七轮确立了主干：独立声明行、展示与派发分开的两个入口、证据来源规则，以及安全前置；
- 之后按成本分析把同步量作为一等约束重新审视，第八至十四轮收敛到当前版本：
  - 去掉基于时间的 TTL 与值中的时间戳，写入序号防护放在内存中；
  - effort/fast 的意图从已有 turn 历史推导，优先级高于 runtime；
  - 投影只凭同步确认省略下发或判断缺席；
  - 快照稳定化经实测不做。

这是 agent 之间的评审，不等于人工批准；实施前仍需要维护者评审，相关 Spec 按 draft 起草。

## 证据

- 代码阅读（`main` 2e0886b8）：`packages/shared/src/ai.ts`、
  `apps/cli/src/agent/acp-capability-normalization.ts`、
  `apps/cli/src/session/session-execution-service.ts`、`apps/cli/src/lib/loro/doc.ts`、
  `apps/cli/src/commands/session.ts`、`apps/cli/src/session/acp-session-config-applier.ts`、
  `packages/components/src/components/shared/acp-selector-options.ts`、
  `packages/components/src/lib/acp-session-config-selection.ts`、
  `packages/components/src/lib/agent-role-schema-reconciliation.ts`、
  `packages/shared/src/message-schemas.ts`、`packages/shared/src/machine-flock.ts`、
  `packages/acp-extension-claude/src/acp-agent.ts`、`packages/acp-extension-codex/src/CodexAcpServer.ts`、
  `packages/acp-extension-codex/src/FastModeConfig.ts`。
- PR #333 的描述与评论。方案经过多轮与 Codex 的交叉评审后修订。
- 未执行任何测试或运行时验证。
