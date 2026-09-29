# 同步重复 turn 副本并保护队列提升

Status: proposed
Translation: current

[English](2026-09-27-duplicate-turn-copy-writes-and-queue-guard.md)

## 摘要

renderer 对排队消息的 steer 和 CLI 的队列提升，可能在不同副本上各自追加同一个排队 turn
（[#1040](https://github.com/LodyAI/Lody/issues/1040)）。
[调度修复决策](../../implemented/bug-fix/2026-09-27-duplicate-turn-dispatch-repair.zh.md)
让这些重复行可以被安全地选择，但状态写入仍只到达最后一条副本，队列提升也可能再次追加
一个已被执行方当作 steer 接收的 turn。现在用户状态写入按各动作的明确规则更新所有副本，
队列提升重新读取 meta，再决定保留、删除还是提升排队行。重复行仍可能产生；本改动让它们
不再分叉、不会执行两次，且不需要协议变更。

## 问题与证据

在 [#460](https://github.com/LodyAI/Lody/pull/460) 之前，`setUserTurnStatus` 遍历整个
history，更新所有同 ID 的用户行。共享 writer 把它换成了反向 `locate`，只改最后一条；
正向的调度扫描于是反复修复过期的第一条，直到 daemon 内存耗尽。#1043 让读取对齐到最后一条。
否则，仍然匹配第一行的读取方和之后的写入，会让过期副本一直可见。

steer RPC 和文档同步是两条独立通道。执行方可能先接收排队行的 steer，并记录
`steerTurnStatuses[id]`，而 renderer 的 `pending_apply` 行和删队列操作尚未到达 CLI。
队列提升只看本地 history，因此可能再次追加同一条输入，把它当作新一轮执行。

## 决策

- `HistoryWriter.updateCopies` 修改所有带该 ID 的已存行。它在第一次 CRDT 修改前准备并校验
  全部替换，然后一次提交。
- `user-status` 改用它。普通写入更新最后一条，并让前面的副本跟随，但不会让已进入终态的副本
  回退。steer 投影要求最后一条为 `pending_apply` 或 `processing`，且只迁移处于这两种状态的
  副本。`requeueUndelivered` 和 `onlyPendingApply` 会重新赋予执行资格，因此任一副本已开始或
  已结束时都会被否决，即使只看最后一条会允许。
- 历史中没有该行时，队列提升在队列租约内重新读取 meta。steer 状态为 `pending` 时保留该行：
  这条输入仍会通过 steer 自己的历史行执行一次。steer 已接收或已结束、turn 正在执行，或存在
  既有的结算证据（`lastHandled`、已结算激活、missing-history tombstone、已完成的 assistant）
  时，删除该行且不追加。这些证据先于 `pending` 判断：恢复流程先写 tombstone 再清除
steer 状态，两次写入之间崩溃不能让队首永久保留。

被拒绝的 steer 若历史始终未到达，会通过 missing-history 恢复结束，随后 tombstone 删除被保留
的排队行，由用户显式重发。否决了"用保留的队列内容自动提升"：`pending` 只证明 provider 没有
接收这次 steer，不能证明队列内容与 renderer 发出的一致，而且会破坏 tombstone 不重放的保证。

## 备选方案

让 CLI 成为唯一的队列消费者可以从源头消除竞态，但需要 steer 请求标明排队行、能力协商以及
客户端升级（包括本仓库之外的客户端），留作单独决策。评审后否决了"重新排队也只看最后一条"：
较早的 `handled` 副本是该 turn 已执行的正面证据，而 `lastHandledUserMsgId` 只保存最近一轮。
删除或去重已存行则是为了选择工作而改写历史。

## 限制

重复行仍会产生，界面上可能显示两次。已有的过期副本只有在该 ID 再次被写入时才会改变。
Edit & Resend 使用 `pendingInput: 'preserve'` 时，会拒绝并发的 steer 而不记录，队列提升仍可能
把该排队输入当作额外一轮执行；这个既有缺口需要执行方拥有的标记。`readTurnOutput`、fork、
copy range 等读取方仍匹配第一行。

## 验证

shared 测试使用真实的 Loro writer：并发副本一起更新；第二个替换非法时文档版本不变；投影跳过
普通和已终态副本；任一已开始或已结束的副本否决两种重新排队标志。CLI 测试把一个排队文档分叉为
两个副本，在最新 meta 上记录执行状态，同时传入过期 meta，覆盖已接收、被拒绝、tombstone 和普通
四种情况，以及 tombstone 已写入的被拒 steer，并验证 renderer 稍后合并的结果。逐一去掉各机制后
对应测试失败：只写最后一条（4）、终态回退（1）、重新排队否决（2）、投影过滤（1）、队列保护（3）、
最新 meta（3）、保留被拒 steer（1）、结算证据先于保留（1）。
设计经 Reviewer Agent Role 评审；未做真实 provider 或 UI 运行。
