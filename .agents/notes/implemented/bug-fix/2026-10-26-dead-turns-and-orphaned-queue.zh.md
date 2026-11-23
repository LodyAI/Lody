# 结束无主 turn，并持续关注未能提升的队列消息

Status: implemented
Translation: current

PR: [#1919](https://github.com/LodyAI/Lody/pull/1919)

[English](2026-10-26-dead-turns-and-orphaned-queue.md)

## 摘要

机器重启后，会话可能永远停在"忙碌"：最后一条 assistant 记录一直没有结束，于是输入框把每条消息都放进队列、Stop 被隐藏，而 daemon 认为没有待办工作，从不处理队列。修复让一个事实决定用户可见的状态——最后一个 assistant turn 是否结束——并由负责该会话的 daemon 结束没有任何执行在负责的 turn：Stop 会结束它；在发出 prompt 之前就给输入定了结果的派发，会当场结束崩溃留下的那条记录。daemon 也不再在队列仍有消息时确认队列信号。本次修改之前已经卡住的会话仍需要一次触发（Stop 或编辑队列消息），因为空闲会话不会在启动时被打开。

## 问题

客户端从历史推出两个决定：最后一条 assistant 记录未结束时，显示 Stop，并把新消息放进队列而不是直接发送。但代码还同时参考在线状态和多个元数据指针，它们彼此矛盾：

- 重启后的崩溃恢复派发在发出 prompt 之前被 Inbox 准入拒绝（上一次执行的资源释放尚未确认）。用户输入被标为 `failed`，但本应由恢复流程重新打开的 assistant 记录一直未结束。
- 因此输入框把每条消息都放进队列；Stop 需要在线状态，被隐藏；daemon 的 Stop 路径只会结束卡在上下文压缩中的无主 turn。
- 派发检查无法提升队列消息时，仍然写入 `messageQueueCheckedAt`，于是会话不再被关注，队列消息再也不会重试。日志无法确定第一次检查为何跳过这条消息（锁冲突或队列消息尚未同步都有可能）；本修复不依赖具体原因。

## 决定

- **界面只用一个判断标准。** `canStopAgentEnabled` 为"最后一个 assistant turn 未结束，或存在可暂停的 goal"。在线状态不再决定 Stop，agent 已退出的 turn 依然可以 Stop。排队还是直接发送原本就使用同一标准。
- **由负责会话的 daemon 结束无主 turn。** `SessionExecutionService.closeDeadAssistantTurn` 在会话改写租约下运行，并再次确认不存在 active、current 或 runtime turn。它只读取历史末尾的目录，因此 Loro 和 Roost 共用同一实现。
  - 对该 turn 的 Stop 无条件结束它：尚未有结果的用户输入先变为 `canceled`（并退役指向它的派发指针），再强制结束记录，顺序与普通 Stop 相同。Stop 仍然不会运行队列。
  - 不运行就给输入定结果的 prompt 前退出路径（Inbox 拦截、输入已结束）会在失败处当场结束该 turn 的记录。只有已有结果的输入（`handled`、`failed`、`canceled`）才符合条件；`processing` 输入仍欠一次崩溃恢复运行，该运行会重新打开同一条记录。
- **队列信号。** `markMessageQueueSignalChecked` 只在本地队列为空时确认，因此无法提升的消息会让会话继续被关注，之后的变更会重试它。

## 考虑过的方案

- **启动时从元数据推断无主 turn。** 否决：空闲会话的元数据没有任何线索，而启动扫描规则禁止在启动时打开所有会话文档。
- **Stop 继续依赖在线状态，只修 daemon。** 否决：将来只要再出现"无在线状态但 turn 未结束"的情况，唯一的出口又会被隐藏。
- **自动结束所有无主的未结束 turn。** 对 `processing` 输入否决：崩溃恢复仍需在同一条记录上运行。
- **每次派发检查都扫描无主 turn。** 否决：每次空闲触发都要读历史并拿改写租约，违反"不按触发扫描"的规则，还可能让同时进行的队列提升拿不到租约。在失败处当场结束覆盖了已观察到的原因，其余情况由 Stop 覆盖。

## 相关但未实现

Claude 适配器会在它启动的后台子 agent 存活期间保持 `session/prompt` 未结束，这段时间 Lody 也会把新输入放进队列。在回答完成时结束 prompt、把后台工作作为会话活动处理（通过 capability 协商），是适配器仓库中的另一项修改。更长期的方向——每个会话一个由 daemon 维护、供输入框、MCP 状态和派发共同读取的执行状态——已讨论，本次未作决定。

## 验证与限制

- 执行服务测试：Stop 能结束普通无主 turn（输入变为 `canceled`、记录结束、指针退役、状态 idle、Stop 标记清除）；只处理已有结果的模式会跳过 `processing` 输入，并结束 `failed` 输入且不改写其状态。原有的重启测试现在先放入一条未结束记录：Inbox 拒绝后输入为 `failed`、记录已结束。原有的压缩 Stop 测试仍通过。
- 基于真实 `SessionDocument` 的 watcher 测试：被持有的租约阻止提升的队列消息不会改变 `messageQueueCheckedAt`，下一次检查时被提升并派发。
- 去掉队列长度保护、"输入已有结果"保护或失败处的结束调用，对应测试会失败。
- 未做实机验证：没有运行桌面端、Web 或 daemon 重启。Stop 按钮的变化需随渲染端发布才会到达用户。
- 已经卡住的会话不会被自动修复：使用新 daemon 时，Stop 会结束无主 turn，编辑队列消息会重新触发队列信号。
