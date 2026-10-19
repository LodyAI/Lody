# 保持访问待定的 Inbox 输入可被重新接纳

Status: implemented
Translation: current
PR: not created

[English](2026-10-15-access-pending-inbox-withdraw.md)

## 摘要

机器访问校验期间控制面短暂不可达，会让一条消息以及同一 Session 之后的所有消息永远无法启动，报错
`INBOX_EXECUTION_REJECTED: inspect blocked resources with lody session recover-inbox`。准备好的派发
在访问结果出来之前就打开了 Operation Inbox execution。访问结果为 `indeterminate` 时，这一轮保持
待处理、等待重试，但 execution 被释放了，而释放会把输入标为已结束，于是每次重试的 `begin` 都被
拒绝。现在这种轮次会撤回（withdraw）尚未提交的 execution，输入保持可接纳。对于输入已经结束、
却仍处于待处理的轮次，现在会以可见提示标记失败，不再堵住队列。

## 证据

2026-10-15 UTC 16:18 到 16:27，同一台机器上三个 Session 的访问校验遇到 `fetch failed` /
`ETIMEDOUT`。daemon 日志显示同一批用户轮次先出现 `access-indeterminate`，随后反复出现
`inbox-prepare-failed`。只读查询 `inbox_inputs` 显示每个受影响输入都是 `finished=1, canceled=0`，
且 `assistant:<userTurnId>` 有一条 `failed` 释放回执。`findNextDispatchableUserTurn` 一直选中最早的
待处理轮次，后面的消息都排在它之后：其中一个 Session 把同一轮重试了 19 次。

## 决定

- **根因修复：撤回而不是释放。** 访问结果为 `indeterminate` 时，准备好的派发会标记 turn runtime。
  轮次结束时，如果 execution 从未开始 prompt 且未被取消，就调用新的 `ExecutionOwner.withdraw`。
  SQLite `withdraw` 只在该 execution 没有释放回执、没有登记过资源、其输入也没有已 fence 或已提交
  的批次时，才清除活动 execution。它不写回执，输入保持未结束。重试复用固定的 execution ID
  `assistant:<userTurnId>`，如果写了回执，重试最终释放时就会与之冲突。已准备好的"人类输入 + 结果"
  批次保留其认领，重试时直接复用。
- **访问仍在可见轮次内解析。** 现有契约要求访问待定期间 turn runtime 已经注册，这样校验过程中
  Stop 和活动调用身份查询都能工作。Inbox 的 Stop 通过这个活动 execution 暂停，所以把 `begin`
  推迟到访问之后会破坏 Stop。
- **兜底已损坏的状态。** 如果 `begin` 拒绝了一个非批次输入，且 SQLite 报告它已结束
  （`inputEnded`：已完成或已取消），该轮会记录 `turn_pre_prompt_failed` 并提示用户重新发送；
  历史中已是终态的除外。Lody 仍然不会重放它。这能修复旧 daemon 留下的卡死 Session，也覆盖将来
  任何在历史仍待处理时就结束输入的路径。其他拒绝原因（资源被阻塞、已有活动 execution、Host
  lease 丢失）保持原有行为。
- 精简竞态模型新增 `withdraw` 事件：未提交的人类 execution 回到待处理的人类输入，穷举探索仍能
  证明至多一次投递。

## 考虑过的方案

- **在打开可见轮次前等待访问。** 否决：它会破坏访问待定期间的 Stop 和调用身份查询，现有测试
  固定了这些行为。
- **用一种新的、不结束输入的释放结果。** 否决：释放回执按固定 execution ID 记录，重试最终释放时
  会冲突并阻塞 Session。
- **把任何被拒绝的输入在历史中标记失败**（早先的本地补丁）。不作为唯一修复：它会把暂时性拒绝
  （例如 Host lease 交接）变成永久失败，每次网络抖动都会丢消息；而且它的历史写入和释放共用一个
  `try`，写入失败会跳过 runtime 清理。

## 验证与限制

`apps/cli/tests/session-execution-service.test.ts` 使用真实 SQLite Inbox 和 Session 历史。
`indeterminate` 派发后输入保持未结束、轮次仍可派发，随后 `allowed` 的重试只发送一次 prompt。
预先存在的已结束输入会被退役，下一条消息正常执行。没有本次改动时两个测试都会失败，错误与线上
一致。`apps/cli/src/orchestration/inbox/inbox.test.ts` 覆盖撤回条件：登记资源、fence 或释放之后
拒绝撤回，撤回后同一 ID 可以再次 begin。`operation-model.test.ts` 追踪了新事件。

访问待定期间 daemon 崩溃时，仍会留下没有回执的活动 execution，这和以前一样，由现有的重启恢复
流程处理。
