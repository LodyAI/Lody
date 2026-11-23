# 由 history 判定 daemon 接手的 guide 拒绝结果

Status: implemented
Translation: current

[English](2026-09-28-daemon-owned-guide-outcome.md)

结论（2026-09-29）：已在 [#1095](https://github.com/LodyAI/Lody/pull/1095) 中实现，从 `proposed/` 移出。已被[移除会话发送日志](../simplification/2026-09-29-remove-session-send-journal.zh.md)替代：daemon 接手（`recoveryOwned`）的拒绝返回后，renderer 不再读取 history、不再记录 guide 结果，也不重试；这条消息由 daemon 负责。结果未知时保持原样，不报告为发送失败。下文的原因分析仍然成立。

## 摘要

用户在向正在工作的会话发送 steer 后，经常看到 “Guide outcome is uncertain; the original turn is retained”，带附件时尤其常见。多数情况下消息并没有丢：daemon 已经证明 steer 没有投递出去，并把这条消息转成了普通后续消息。renderer 不认识这个答复，把它报成了结果未知。现在，daemon 接手的拒绝返回后，发送日志会读取这条消息的 history，如果已被转成后续消息或已经结束，就视为已处理。

## 原因

`SessionExecutionService.steerSessionLocked` 给所有拒绝都加上 `recoveryOwned: true`。对于能证明发生在提交给 provider 之前的拒绝（`no-active-turn`、`stale-turn`、`busy`、`unsupported`），`rejectAndPromote` 会先执行 `requeueUndeliveredSteer`：把 history 行从 `pending_apply` 改为 `pending`，并设置 `steerTurnStatuses[id] = 'pending'`。`getPendingUserTurnActivationId` 把后者当作一次激活，之后 daemon 自己执行这条消息。

发送日志的 guide 投递逻辑（`workspace-session-send-journal.ts`）只接受 `applied` 和 `no-active-turn`，其余一律报错。附件需要先上传时，`stale-turn` 很常见：等到发出 steer，目标 assistant turn 往往已经被替换。这个错误表现为“发送失败” toast（本 PR 之前也显示在待发送面板里）。点“继续发送”后能成功，因为重试逻辑会读取 history，看到的状态已是 `pending`。

没有发送日志记录时走的 steer 路径（`session-submission.ts`）也有同样的问题，只处理了 daemon 接手的 `no-active-turn`。

## 决策

- **由 history 判定，而不是 disposition。** 同一个 `stale-turn` 响应，可能是 daemon 已经把消息转成后续消息，也可能是它有意保留了原状（取消时不转成后续消息，例如 Edit & Resend），两者形状完全相同。daemon 接手的拒绝返回后，renderer 等待目标同步，再用 `readGuideTurnOutcome` 读取这条消息：
  - 状态是 `pending`、`seen` 或任何已结束的状态，说明 daemon 已经处理。发送日志记为 `guideOffer: 'recovered'`，并把记录标为已投递。
  - 状态是 `pending_apply`、`delivery_unknown`，或者行不存在，仍视为结果未知，保留错误。
- **renderer 绝不 dispatch 已恢复的 guide。** `recoveryOwned` 表示恢复由 daemon 负责，renderer 再发布 dispatch 指针可能覆盖更新的激活。`'recovered'` 会持久化，崩溃后重试也不会发起 dispatch。
- **`promotion-failed` 通过 daemon 重试一次**，与无记录路径原有的做法一致。
- **答复丢失后的重试路径同样把 `delivery_unknown` 视为未知。** 之前的判断把除 `pending_apply` 以外的任何状态都当作证据，因此 `delivery_unknown` 的消息可能被再次 dispatch。

## 验证

- `tests/session-send-journal.test.ts` 使用真实的 workspace 发送日志和会话文档。`stale-turn`、`busy`、`unsupported` 在消息已被转成后续消息时，记录变为已投递，`guideOffer` 为 `recovered`，没有 dispatch，也没有写激活指针。消息保持原状的 `stale-turn` 和 `delivery-unknown` 停留在 committed 阶段，并带有结果未知的错误。
- `tests/use-session-actions.test.ts`：无记录路径遇到 daemon 接手且已转成后续消息的 `stale-turn` 时，返回“未应用”，不发起 dispatch。旧版（非 daemon 接手）以及消息保持原状的情况仍然报错。

## 限制

- 转成后续消息的结果要通过目标同步才能看到。如果同步跟不上，读到的仍是 `pending_apply`，错误会保留；重试时会重新核对。
- 答复中不带 `recoveryOwned` 的旧版 daemon 保持原有行为。

相关：[侧边栏发送状态](../feature/2026-09-28-sidebar-send-status.zh.md)、[Session files Spec §6.3](../../../../specs/session-files.zh.md#63-direct--queue--guide)。
