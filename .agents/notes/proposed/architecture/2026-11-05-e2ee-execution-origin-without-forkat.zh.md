# 不用 forkAt 的 E2EE 执行来源校验

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2344

[English](2026-11-05-e2ee-execution-origin-without-forkat.md)

## 摘要

加密启动门禁要证明 Turn 或 Schedule 声明是谁写的，做法是把 Loro 文档 fork 回签名增量的依赖版本，再导入
原始字节。这需要为每个 Session 和 Schedule 更新保留密文，还要从 Streams 回填，并且每一帧都要 fork 一次
整个文档。2026-11-05 owner 决定在 E2EE 验收后去掉这套机制，接受更简单的过渡校验，更强的完整性后续放到
Roost。本 note 提议按写入者分别取证：人的输入（含排队输入）用已签名的 purpose-8 dispatch 原件；机器自写
的输入用本地收据；Schedule 用帧签名者加后续修改检查。主要取舍是 Schedule 声明不再能证明确切载荷，没有
dispatch 原件的人类 Turn 也不能再启动。本 note 描述 main `85e338e42`。排队部分已实现；fork 本身仍在，设计的其余部分没有实现或运行。

## 当前状态

| 部分 | 状态 |
| --- | --- |
| 排队输入证据 | 已在 [#2345](../../implemented/bug-fix/2026-11-05-e2ee-queued-input-evidence.zh.md) 实现：`queueDispatchOriginals`、`queuedInput` 标记、自动化行的 `queued_inputs` 收据 |
| 请求者和机器访问 | 已在 [#2352](../../implemented/bug-fix/2026-11-06-e2ee-verified-requester.zh.md) 实现：请求者来自已验证的签名者，访问在本地判定 |
| 账本用户 ID | #2365 起就是账户 ID。账本格式未变，本设计不依赖它 |
| 队列行的写者绑定 | 试过并已删除，不属于本设计 |
| `resolve` 和 `resolveSchedule` 里的 `forkAt` | 仍在运行，验收后再去掉 |
| 其余机器自写输入的收据 | 未实现 |
| Schedule 帧签名者路径、减少 `frames`/`spans` | 未实现 |

## 范围

三项保证不可妥协：加密工作区要么加密要么拒绝，不回退明文；精确重试保留原 ID、记录、签名和密文；非成员
以及已移除或已撤销的设备不能获得执行权限。动摇这三项的方案都会标出且不推荐。不改 ledger 格式。不依赖
仍在讨论的 Rust 本地数据引擎。

## 今天 forkAt 在哪里运行

两处 fork 都在 [`execution-origins.ts`](../../../../apps/cli/src/lib/e2ee/execution-origins.ts)：Session Turn
走 `resolve`，Schedule 声明走 `resolveSchedule`。到 `resolve` 的唯一入口是
[`workspace-legacy.ts`](../../../../apps/cli/src/lib/e2ee/workspace-legacy.ts) 的
`resolveVerifiedExecutionOriginal`。加密 Session 固定使用 Loro 历史后端：`prepareCreate` 强制选择，发送准入
用 `e2ee_history_backend_unavailable` 拒绝 Roost。

| 入口 | 行的签名者 | 何时走到 forkAt |
| --- | --- | --- |
| 人的 Turn，dispatch 投递 | 客户端设备 | `rpcDispatchOriginals` 和接收缓存里都没有原件：准备失败或超时、host 无此能力、或 Turn 缺 `inputConfig`、`userId`、`timestamp` |
| 人的 Turn，`history` 投递 | 客户端设备 | 总是；不调用 `dispatchUserTurn` |
| 队列提升（`promoteNextQueuedMessage`） | **当前机器** | 总是。签名行检查先运行并覆盖 `queuedInput`；作者证据再取自 `queueDispatchOriginals` 或收据 |
| 被拒绝的 steer | 客户端设备 | 客户端 `promoteGuideToFollowUp` 路径不会，它走 dispatch。steer 路径写自己的行，拒绝只改状态 |
| Agent 驱动的 owner 工作（`lody session` 创建/发送、MCP） | 当前机器 | 总是：自签原件会落到已签名的行 |
| 派生输入（`derivedFrom`，共享成员派生） | 当前机器 | 总是。其来源 Turn 还会再解析一次，见下一行 |
| 派生来源查询（`classifyOrigin`、`verifiedOrigin`） | 成员 | `lookup.origin` 跳过文档里的原件，只有缓存的接收原件能避开 fork。写入时检查遇到 owner 的活跃 Turn 会提前返回 |
| 生成的 Schedule Turn（`scheduleRun`） | 当前机器 | 总是，然后还要走 `resolveSchedule` |
| 自动化队列行（`pushMessageQueue`） | 当前机器 | 总是，经队列提升，在比较收据之前 |
| Schedule 交接（`schedule-engine` 的 `authorize`） | 定义的签名者 | 总是；包含声明的每个已签名帧 fork 一次 |
| Schedule 实际启动（`claim` → `authorizeSchedule`） | 定义的签名者 | 总是，每个解析出的项目目标重复一次 |
| Schedule 手动运行 | 定义和请求的签名者 | 以上两者，覆盖两条声明 |

### 影响设计的发现

- **排队输入有自己的证据。** 提升时由当前机器写历史行，所以行的签名指向机器。作者证据单独携带，不依赖 forkAt。
- **对人的输入，dispatch 原件本身就是已签名的意图。** 它绑定请求 ID、目标机器、期限、会话、Turn、`userId`、
  时间戳和 `inputConfig`，而该配置通常带 `prompt` 和 `inputBlocks`。`resolveDispatchTurnInput` 优先用它们，
  而不是行的 `items`，所以实际执行的文本已被覆盖。只有配置里没有 blocks 时才回退到未签名的 `items`。
- **fork 做的不只是确认签名者。** 把重建的行与当前行比较，也覆盖了 `inputConfig`、`items`、`scheduleRun` 和
  `derivedFrom` 的后续修改。行字段是各自独立的操作，状态更新又在同一个 map 上，所以对 Turn 不能用容器级的"此后是否改动"
  代替。对 Schedule 可以：`scheduleChangedSince` 已存在，只需要一个版本。
- **机器自写的行，签名证明不了多少。** 机器本来就知道是自己写的。`seal` 不保留任何东西，所以 `retain` 只有
  在读回自己的更新时才能看到这类帧，否则要靠回填。这是否增加启动延迟没有测量。

## 方案

| | A：去掉 fork，保留帧签名者 | B：按写入者取证（推荐） | C：签名执行意图 |
| --- | --- | --- | --- |
| 人的 Turn | 包含创建操作的帧的签名者 | 只用 dispatch 原件 | 新的签名记录 |
| 排队输入 | 不额外做就解决不了 | dispatch 原件随行存放 | 新的签名记录 |
| 机器输入 | 自己帧的签名者 | 带行摘要的本地收据 | 机器签名的记录 |
| Schedule | 帧签名者 + `scheduleChangedSince` | 同 A | 签名声明 |
| 客户端改动 | 无 | 无剩余：队列路径已发布 | 桌面、Web、手机、CLI |
| 新格式 | 无 | 无剩余：文档 map 和收据表已发布 | 新签名记录及期限规则 |
| `frames`/`spans` | 全部保留 | 仅保留 Schedule 房间 | 可删除 |
| 是否破坏不可妥协项 | **是，第三项：不推荐** | 否；见下方保证对比 | 否 |

**方案 A** 是字面上的最小改动，约 40 行，没有上线顺序问题。它保留 Turn 创建的签名者，但不再把后续行改动与已签名内容比较，
所以不满足第三项不可妥协的保证，不推荐。

**方案 C** 是此前 E2EE 讨论提过的设计：成员设备签名会话、Turn、内容摘要、配置、可选的 `derivedFrom` 和
Schedule、目标及期限。它最强，也能让 `frames`/`spans` 退场。但它需要新格式、所有客户端改动、适合长期
Schedule 的期限（dispatch 帧上限 15 分钟）和 Spec 修订，而且会替代 Roost 后续该提供的大部分能力。方案 B 在
已有签名格式的地方沿用同样的思路，以后仍可走到 C。

## 提议设计（方案 B）

```text
claim(userTurnId)
  resolveVerifiedExecutionOriginal
    有机器自写收据     -> 当前行的摘要必须匹配 -> 以机器为请求者
    有 dispatch 原件 -> openDispatch，绑定 session/turn/config -> 帧签名者
    都没有         -> pending 到 Turn 窗口结束，然后 expired
  scheduleRun?     -> authorizeSchedule（帧签名者 + 无后续修改）
  derivedFrom?     -> 同样解析来源，然后使用来源成员的权限
  authorizeExecution、journal claim（不变）
```

- **人的输入。** dispatch 原件成为唯一证据。行的 `inputConfig` 必须与签名的一致，和今天相同；`resolve` 及其
  fork 删除。没有 input blocks 的配置直接拒绝，不回退到未签名的 `items`。
- **排队输入。** [已实现的证据](../../implemented/bug-fix/2026-11-05-e2ee-queued-input-evidence.zh.md)保留。今天签名行检查先运行并覆盖 `queuedInput` 标记。该检查
  删除后，标记只决定去哪里读原件：请求者由帧签名者或收据决定，`_lodyAutomation` 必须有收据。比较仍用
  `queuedInputEvidence`。
- **机器自写输入。** 自动化队列行已把收据记入 `queued_inputs`。其余写入点同样在写历史前记录
  `(sessionId, userTurnId, digest)`。摘要覆盖门禁今天比较的同一组投影字段。既没有匹配收据也没有 dispatch 原件
  的行不会启动，其 `derivedFrom` 和 `scheduleRun` 同样如此，漏掉的写入点也会在测试里失败封闭。
- **派生。** 来源查询从文档或接收缓存读取成员的 dispatch 原件，其余规则不变。来源没有帧则拒绝派生。
- **Schedule。** `resolveSchedule` 保留已存帧和恢复逻辑，但不再 fork。它打开覆盖声明操作的帧，取签名者，把
  `doc.frontiersToVV(meta.startFrontiers)` 与帧的结束版本向量合并作为已签名版本，交给 `scheduleChangedSince`。
  指纹和声明从当前文档读取。[声明](../../implemented/bug-fix/2026-10-28-e2ee-schedule-origin-authorization.zh.md)
  格式不变，定义无需重新保存。
- **不变的部分。** `agent-start:<userTurnId>` journal、`authorizeExecution`、新鲜度围栏、期限、RPC 原件和重试
  行为。不碰"要么加密要么拒绝"的边界。

### 各方案的保证对比

| 保证 | 今天 | 方案 A | 方案 B | 方案 C |
| --- | --- | --- | --- | --- |
| 启动时确认签名者 | 是 | 是 | 是 | 是 |
| 启动时检查当前账本 | 是 | 是 | 是 | 是 |
| 执行的 Turn 内容与签名一致 | 是 | 否 | 是 | 是 |
| 显示的 `items` 与签名一致 | 仅 fork 路径 | 否 | 否 | 是 |
| Schedule 声明拒绝后续修改 | 是 | 是 | 是 | 是 |
| Schedule 声明证明确切载荷 | 是 | 否 | 否，留给 Roost | 是 |
| 没有 dispatch 原件的人类 Turn 能启动 | 是，排队输入除外 | 是，排队输入除外 | 否，发送者看到拒绝 | 否 |

方案 B 的取舍是缺原件时的可用性和 Schedule 载荷校验，两者都列在下方待 owner 决定。缺机器收据时拒绝该输入。

## Roost 后续

Roost 历史有 seal、owner 和序列规则，以及每个写者的签名身份。[写者身份提议](2026-10-11-roost-writer-identity.zh.md)
让每个可独立写入的副本有自己的密钥，并经授权的公开范围绑定。加密 Session 目前不能用 Roost，完整性校验要等它能用
之后再接入。大概的接入点是唯一的解析函数：`resolveVerifiedExecutionOriginal` 返回 `VerifiedExecutionOriginal`。
为了不挡路，过渡方案保留这个单一接入点，保留 `userTurnId` 作为业务身份和 journal 键，保留 `scheduleRun`、
`derivedFrom` 作为行字段，并且不把授权信息写进行字段。这里不设计 Roost 协议。

## 老客户端和已有数据

E2EE 仍在 test-build 阶段，"老客户端"指较早的测试构建。

| 客户端 / CLI | 结果 |
| --- | --- |
| 新客户端，旧 CLI | 新 map 被忽略，行为同今天 |
| 旧客户端，新 CLI | dispatch Turn 正常。排队行不启动，#2345 起已是如此 |
| 新客户端，新 CLI | 目标状态 |

- **顺序。** 客户端改动已发布。用一个 PR 原子切换 CLI 门禁。不保留回退到 fork 的路径，否则要删的代码还在。
  实现排在验收之后，所以不影响生产部署和验收顺序。
- **已有数据。** 不需要迁移。终态 Turn 不会重新校验，journal 先给出答案；pending 的 Turn 15 分钟内过期；升级时
  在途的机器输入没有收据，会过期，下一次 Schedule 触发时重新生成。Schedule 声明和账本数据不变。
- **Web 和手机。** 源码不在本仓库。按队列 note 的记录，它们经 `lody-oss` 版本走共享发送路径。直接发送还没有设备运行确认，切换 CLI 前要确认。

## 减少 `frames` 和 `spans`

可以，但只是部分。Session 房间不再写入，按更新增长的密文和 Session Turn 的回填随之消失。Schedule 房间两者都
保留。已有行留在原处：[执行声明 note](2026-10-28-encrypted-agent-execution-claim.zh.md) 记录了不做证据裁剪，所以
一次性删除要另行决定。`rpcDispatchOriginals` 和新 map 会随 Turn 继续增长，相当于文档里多一份签名输入的 hex。
这里不裁剪，因为精确重试依赖它们。只有方案 C 才能移除这两张表。

## 实现计划

行数是估算，不含生成文件。

| PR | 改动 | 规模（代码 + 测试） |
| --- | --- | --- |
| 1 | CLI：其余写入点记录收据，门禁暂不使用 | ~200 + ~200 |
| 2 | CLI 门禁切换：只用收据和原件、队列规则、删除 `resolve` 及 Session 的 `retain`/回填 | -130/+80 + ~300 改写 |
| 3 | CLI 和共享包：Schedule 帧签名者路径，删除最后一处 fork | ~50 + ~100 |
| 4 | Spec 修订、`AGENTS.md`、本 note 移到 `implemented/` | 文档 |

PR 2、3 最后落地，并放进同一个测试构建，因为这条路径把守每次加密启动，改动会使验收证据失效。

回归范围：A、B、C、手机、Schedule 全部重跑，包括：

- owner 和共享成员的 dispatch，RPC 先于和晚于历史到达。
- 两者的排队输入，含编辑、自动化行和超过窗口的队列。
- owner Turn 和成员 Turn 发起的 MCP 子会话、chat、Role；跨机器被拒绝。
- Schedule 定义、手动运行、编辑失效、签名者检查、多项目。
- claim 中途 daemon 重启、不确定启动的精确重试、仅快照副本。
- pending 启动期间的设备撤销、成员移除和撤回共享。

`apps/cli/tests/e2ee-runtime.test.ts` 的夹具沿用，固定 Schedule 载荷校验的用例除外。

## Spec 影响

[`specs/e2ee-foundations.md`](../../../../specs/e2ee-foundations.md) 需要人工审核的修订：派生工作段落和来源表述都
建立在签名原件链上。白皮书已说明此格式不提供逐操作作者证明，无需修订。`apps/cli/src/lib/e2ee/AGENTS.md`、
`apps/cli/src/lib/schedules/AGENTS.md` 和 CLI README 随实现更新。本 note 不批准任何 Spec。

## 待决定事项

1. Schedule 载荷校验是否可以留给 Roost，还是 Schedule 保留 fork 直到那时。
2. 没有原件的人类 Turn 是否失败封闭（推荐），而不是保留回退。
3. 批准上述 Spec 修订。

## 被否决的替代方案

- *不要证据，直接信任行。* 启动时没有签名者身份，不满足第三项保证。
- *Schedule 用已签名的 feature 帧。* 格式工作量与方案 C 相同，还有 15 分钟上限。
- *逐键检查最后编辑者。* `LoroMap.getLastEditor` 只报告 peer，也覆盖不到嵌套容器。

## 验证限制

盘点和发现来自代码阅读；相关 note 列出的测试只覆盖已发布的部分，本文提议的内容都没有运行。`frontiersToVV` 存在于锁定的 `loro-crdt` 1.17.0
类型声明中，但它在仅快照副本上的行为和今天 fork 的开销都没有验证或测量。Web 和手机行为无法从本仓库确认。规模是估算。

相关：[执行声明](2026-10-28-encrypted-agent-execution-claim.zh.md)；
[Schedule 来源](../../implemented/bug-fix/2026-10-28-e2ee-schedule-origin-authorization.zh.md)；
[派生工作](2026-10-31-e2ee-shared-member-derivation.zh.md)；
[机器共享](2026-10-28-e2ee-machine-sharing.zh.md)。
