# 按精确身份校验 PR 终态

Status: implemented
Translation: current

[English](2026-09-13-terminal-pr-status-verification.md)

Pull request: [#670](https://github.com/LodyAI/Lody/pull/670)

## 摘要

托管 fan-out 可能乱序覆盖生命周期元数据，导致 GitHub 已合并同一个 Pull Request 后，会话
侧栏仍显示 `closed`。终态 reconciliation 现在通过精确的 `pullRequest(number:)` 查询已知
current PR，并持久化包含仓库、URL/number 和存储 lifecycle 的 generation。生命周期覆盖会
因此重新启用校验；`closed` 需要两次有间隔的同值观察，以覆盖 GitHub 合并后的读取窗口，
`merged` 则立即生效。真实托管 fan-out 尚未实测。

## 问题

侧栏读取 `SessionMeta.pullRequests`，当前会话则从 GitHub 获取 PR 详情。PR #649 暴露了两个
视图的分裂：存储元数据是 `closed`，GitHub 却报告 `MERGED`。托管 webhook 到 Streams 的
路径会盲写单个 PR，因此较旧的 `closed` 更新在本地修正后才到达时，reconciler 也必须恢复。

Branch query 无法证明这个约束。Discovery 按 head branch 查询最近的终态 PR；多个历史 PR
可能共用同一 branch，而且有效响应也可能不包含存储中的 current PR。把 branch discovery
成功当成校验成功，会给错误 URL 盖章，并让陈旧 lifecycle 永久保留。

## 决策

Branch discovery 保留 `(repository, runtime branch)` 身份，只负责关联和 current PR 排序。
当前终态 PR 会额外产生一个使用解析后仓库与 number 的精确 status target。持久化的校验
generation 是：

```text
repository | PR number | PR URL | stored lifecycle
```

只有 exact alias 返回指定 PR，且 fresh-meta 写回完成后，scheduler 才记录这个 generation。
如果终态 exact alias 缺失或格式错误，同一个 owner 的 branch discovery 不能关联、写回或
记录 fingerprint，因为它缺少安全排序所需的 current PR 证据。

匹配的 `merged` 结果会立即完成校验。第一次匹配的 `closed` 只记录 target success，不记录
verification generation；按正常 status cadence 得到第二次同值结果后，才确认 PR 确实关闭。
如果第二次返回 `merged`，写回会产生新的 merged generation，并在休眠前再做一次 exact
query。以后任何 `merged` 到 `closed` 的覆盖都会改变 generation，从而自动重复此流程，
daemon 重启后同样成立。

调度状态保存在可丢弃的 SQLite `terminal_verification_fingerprints` 表中。它不是 PR status
缓存；Session metadata 仍是写入判据，GitHub 仍提供 observation。

## 替代方案

没有使用终态 branch-discovery 结果，因为它标识 branch，而不是已知 PR。没有从 generation
中移除 lifecycle，因为同 URL 的迟到覆盖会命中旧 fingerprint，之后无法自愈。也没有无限
轮询全部终态 PR，而是对 merged 做一次 exact 校验，或对 closed 做两次有间隔的 exact 观察。

## 故障恢复与回滚

Provider、解析、关联或写回失败时，不记录 generation，并保持到期重试。运维可设置
`LODY_PR_POLL_DISABLED=1` 禁用 reconciler，部署旧 scheduler，并删除
`terminal_verification_fingerprints` 表中的行或整个可丢弃的 `pr-poller-state.sqlite3`；删除只会
触发保守重查，不会丢失 PR status 数据。

## 证据与限制

确定性的 target、scheduler 与 SQLite 测试覆盖 exact alias 构造、branch discovery 返回其他
PR、先 `closed` 后 `merged`、同 URL 的迟到 `closed` 覆盖、携带 merged generation 重启，以及
同仓库同 branch 的两个 owner 指向不同终态 PR。完整 PR-poller 测试套件还覆盖这些 scheduler
测试周围的真实 GraphQL batch builder 与解析结果契约。

测试使用合成 observation 和假时钟。包含 GitHub 响应、托管 fan-out 写入、reconciler 日志、
最终 Session metadata 与 SQLite 行变化的真实 merge timeline 尚未采集；这项运维证据必须在
已登录的托管环境中取得，不能在此声称已经完成。
