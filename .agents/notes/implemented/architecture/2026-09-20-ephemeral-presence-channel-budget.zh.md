# ephemeral presence 通道是一份送达预算，不是数据通路

Status: implemented
Translation: current

[English](2026-09-20-ephemeral-presence-channel-budget.md)

## 摘要

一个工作区通过一条 ephemeral Loro 传输发布在线状态，该传输的队列串行、不合并、无上限，
而机器心跳与该工作区内其他所有 presence 写入方共用它。因此产出快过网络排空的写入方会延迟
心跳；又因为心跳的 `updatedAt` 在创建时而非发送时写入，被延迟的心跳送达时已超出 90 秒
时效窗口：读取端收到了它，却仍报告机器离线，而此时房间状态是 `joined`，任何地方都不会
抛出错误。本次改动把由此产生的义务确立为绑定不变量 —— 只发布小体积、低频率的在线状态 ——
并修复了全量审计中发现的唯一一处线上违规。

## 决策

### 把约束写成发布方的义务，而不是等传输层修复

串行 FIFO、缺失的合并以及无上限重试预算，都位于 `@loro-dev/streams-crdt`
（`EphemeralStreamCrdt`，检查版本 0.15.1），本仓库无法控制。等待上游提供"合并被覆盖条目"
或"心跳优先"的队列，等于让现有每个写入方都可以随时重现这次故障，因此约束被写在当下就能
强制执行的位置：发布方。`specs/loro-ephemeral-presence-channel.md` 记录意图与读取端契约，
并列出四项义务：速率有界、体积有界、仅最新状态、不得饿死共享通道。

### 把规则放在 agent 真正会读到的位置

不变量被有意重复放置，且与代码的距离逐级缩短：Spec 承载意图；
`apps/cli/src/lib/loro/AGENTS.md` 承载一段绑定规则；
`.agents/docs/cli-lib-loro-presence.md` 承载路由出去的细节与排查流程；而写入边界本身 ——
`LODY_PRESENCE_CHANNEL`、`CliPresenceRuntime.writeLocalOrigin`、
`SessionActivePresenceController.setPhase` —— 在自己的文档注释里携带该约束，因为那是编辑
这些文件的 agent 最先看到的东西。新增的 `.claude/skills/lody-loro-sync-stack/SKILL.md`
覆盖通道拓扑，供不是从上述文件开始的工作使用。

路由是必需的，不是风格选择：该 `AGENTS.md` 距离 8 KiB 硬上限只剩 123 字节，因此 presence
主题的解释部分移入 `.agents/docs/` 并留下必读触发句，这正是本仓库对超大 `AGENTS.md` 给出的
处理方式。

### 去重不是限流

`setPhase` 会跳过完全相同的 `(phase, detail)`。这个判断看起来像限流，其实不是：携带百分比、
计数器或流式标签的 `detail` 每次调用都不同，于是按来源的速率发布。AGENTS.md 规则和该方法
自身的注释现在都明确写出这一点，因为这正是导致本次故障以及下述违规的具体陷阱。

### 在发布方限速，而不是在 presence 边界限速

`managed-agent-runtime.ts` 在 `Transform.transform` 回调中发射下载进度 —— 每个流 chunk
一次 —— 且仅在百分比**未变化**时才限流，因此百分比一变就立即发布。而一个监听方会把这些
事件重新发布为会话 presence。修复把上限改为纯时间维度
（`MANAGED_RUNTIME_PROGRESS_MIN_INTERVAL_MS`，500ms），使发射速率成为发布方的属性，而不是
下载的属性。修在来源而不是 presence 监听方，同时保护了该扇出的其他消费者 —— 扇出会随等待
同一运行时的会话数成倍放大。终态不会丢失，因为调用方在 pipeline 结束后已有一次强制发射。

`packages/shared/src/presence.ts` 中还残留着最后一个无上限自由文本字段
（`initializing.detail`）；它现在采用与已被 revert 的 `running.detail` 相同的 280 字符上限，
于是"体积有界"由 schema 强制，而不是靠约定。

## 审计结果

已审查每一个 ephemeral 写入方。存在两条通道，位于不同的 stream URL，因而队列也彼此独立：
`presence` 与 `machine-monitor`。保持两者分离是承重的 —— machine-monitor 快照比 presence
通道允许承载的任何内容都更大更频繁，合并会把这些流量排到心跳前面。

发现并修复了一处线上违规（上文的受管运行时下载进度）。另有三处值得关注，本次**刻意未改**，
因为每一处都需要各自的测量与独立范围：

- `workspace-presence-transport.ts` 在挂载和会话切换时发布 session-viewing，没有防抖，
  且一次切换是一删一写。快速键盘导航可以把它推到远超人类切换速率的水平。
- `CliPresenceRuntime.republishLocalState()` 在每个 `joined` 边沿遍历所有活跃会话，因此
  会话数多的机器在连接抖动时会在心跳前产生突发，而心跳本身也在同一轮被重写。
- `message-handler.ts` 从 ACP 事件的 promise 链中发布图像生成阶段；目前受 `setPhase` 去重
  约束，但它位于事件路径上。

`local-loro-data-plane-server.ts` 已经把突发合并为单帧并在写入时刻取快照，它是修复上述三处
的模板。

### 「未知」不等于「离线」

写入侧只覆盖了契约的一半。`getOnlineMachineIds()` 在 presence room 无法加入时返回 null，
作用域规则把它定义为状态**未知**，而 MCP 服务端用 `?.has(id) === true` 把它坍缩成了离线。
一个辅助函数扇出到五处 agent 可见的后果：单命令派发与两条批量路径都抛出 `MACHINE_OFFLINE`，
会话列表报告 `temporarily_blocked`，选项路径则**静默**地把所有远端机器从候选列表中删除。
null 分支此前完全没有测试，而 `commands/agent-config.ts` 早已正确处理并在注释里写明了原因。

现在 liveness 是三态查询，守卫只在明确的 `offline` 时阻塞。状态未知的机器继续执行，并在
自己的截止期限上失败 —— 这是诚实的慢失败，而不是迅速的错误失败，与 agent-config 的立场一致。
守护进程冷启动或重连退避就足以让 presence room 不可用，因此这条路径无需任何突发即可触发。

`lody machine list` 有对应的报告缺陷：未知状态只存在于一条 stderr 警告里，而 stdout 输出
`online: false`，于是任何解析 `--json` 的消费者都会记录下一个确定的"离线"。`online` 保持原义，
新增的 `onlineStatus` 字段承载全部三种状态。`--online-only` 仍按"已证明在线"过滤，对该标志
而言是正确的，警告也仍会输出。

反向映射刻意未动：`session_status_many` 的 `machineOnline` 来自实时 RPC 而非 presence，
属于不同来源，不在本契约范围内。

## 验证

`managed-agent-runtime.test.ts` 用冻结时钟和 64 个已投递 chunk 锁定该上限：只有三次生命周期
发射存活，且终态字节数仍被报告。把修复消融回按百分比判断后，这 3 次变成 47 次，说明该测试
确实能发现回归，而不是静默通过。只有 `Date` 被伪造，下载 pipeline 保留真实 I/O 调度。

两处 liveness 修复都由测试锁定，它们区分「已加入房间但缺少条目」与「无法检查」；消融任一处
坍缩都恰好让其中一个测试失败。`pnpm --filter lody test` 与 `pnpm --filter @lody/shared test`
覆盖 presence schema 上限与未改动的写入方。本 note 记录的是基于源码检查的审计和确定性的单元级约束，
不构成"关注清单上的写入方已在生产负载下被测量过"的证据；触发本次工作的线上故障也从未在完整
观测条件下端到端复现。

## 关联

触发该不变量的线上故障，以及造成故障的、已被 revert 的生产者，记录在
[已驳回的 transient-reasoning note](../../rejected/bug-fix/2026-09-18-codex-transient-reasoning.zh.md)。
