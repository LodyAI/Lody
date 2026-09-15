# 持续校正 closed PR，直到 GitHub 报告最终 merge

Status: implemented
Translation: current

[English](2026-09-13-terminal-pr-status-verification.md)

Pull request: [#670](https://github.com/LodyAI/Lody/pull/670)

## 摘要

会话侧栏可能把已合并的 Pull Request 显示为 `closed`，因为压缩后的
`SessionMeta.pullRequests` 投影既没有 provider 版本，也没有独立的 merge 证据。GitHub 同时把
merge 表示为 `closed` webhook activity 加独立的 `merged` 标志，而 GraphQL 的
`PullRequestState` 会区分 `CLOSED` 与 `MERGED`。

Reconciler 现在把 `closed` 视为可逆状态，并持续按已知 PR number 做精确查询。只有 `merged`
是最终状态。写回时，fresh meta 中的 `merged` 是吸收态，因此较早完成的 `closed` 查询不能将
它降级。系统不再用查询次数或持久化 fingerprint 证明 `closed` 已经最终确定。

## 状态模型

`draft`、`open`、`closed` 都可能变化，`merged` 不可逆。轮询据此工作：

- 已知的 `draft`、`open`、`closed` PR 都保留精确的 `pullRequest(number:)` status target；
- lifecycle 变化会产生新的 cadence key，并立即到期；
- 已知的 `merged` PR 不再产生 status target；
- branch discovery 只负责关联，与已知 PR 的校验相互独立。

Cadence key 中的 lifecycle 只是可丢弃的调度记忆。它保证 `open → closed` 元数据事件不会继承
上一次 open poll 的时间。target 消失后该 key 会被删除，因此迟到的 `merged → closed` 覆盖会
重新立即到期。

## 写入顺序

Scheduler 针对重新读取的 owner meta 规划写回。如果 GitHub 返回 `closed`，但 hosted fan-out
在请求途中已写入 `merged`，write-back 会保留 `merged`。这是唯一不需要共享时钟的 lifecycle
顺序规则：GitHub 不支持把已 merge 的 PR 还原为未 merge。

可逆状态不作同样保证。陈旧响应可能短暂覆盖它们，但 target 会继续调度，并通过后续 exact
observation 收敛。重复得到相同 `closed` 永远不会抑制后续查询。

## 故障恢复与回滚

Provider、解析或写回失败都会让 target 保持到期重试。陈旧的 `closed` 响应也只算一次普通
刷新，不会成为终态校验证据。运维可以用 `LODY_PR_POLL_DISABLED=1` 禁用 reconciler，或部署
旧 scheduler。SQLite 仍只保存可丢弃的 cadence/quota 记忆，不包含 lifecycle verification 表。

## 证据与限制

PR #649 已合并。2026-09-13 的 GitHub REST 响应同时包含 `state: closed` 与 `merged: true`，
而 GitHub PR/GraphQL 视图报告 `MERGED`。这证明了产生分裂视图的表示边界，但不能单独证明
hosted 写入来自错误的 webhook 投影还是迟到的 fan-out；仍需 hosted webhook delivery timeline
区分这两个来源。

确定性测试覆盖 exact identity、重复陈旧 `closed` 后出现 `merged`、迟到的 `closed` 覆盖、
合法 reopen，以及 in-flight `closed` 查询与 fresh `merged` meta 写入竞争。测试使用合成 hosted
写入与假时钟；hosted delivery path 不在这个公共仓库中。
