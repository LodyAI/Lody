# Reconciler 休眠前校验 PR 终态

Status: implemented
Translation: current

[English](2026-09-13-terminal-pr-status-verification.md)

## 摘要

GitHub 已合并同一个 Pull Request 后，会话侧栏仍可能保留红色 `closed` 图标，而当前会话
通过新鲜详情请求显示 `merged`。本地 reconciler 此前会把“分支已 discovery 且元数据为任意
终态”直接视为永久休眠。现在，终态 discovery generation 会包含当前 PR URL，从而在再次
休眠前强制执行一次权威查询；代价是每次进入终态增加一个请求，同时避免持续轮询终态 PR。

## 问题

紧凑侧栏读取 `SessionMeta.pullRequests`，当前会话则请求 GitHub 详情，并从响应推导生命周期
状态。PR #649 暴露了两个视图的分裂：存储元数据是 `closed`，GitHub 权威状态却是 `MERGED`。
Reconciler 无法修复存储值，因为 status target 按设计只包含 open/draft PR，而且一旦存储中的
当前 PR 进入终态，已有的分支 discovery fingerprint 会立即抑制后续 discovery。

## 决策

继续让终态 PR 退出周期性 status 轮询；同时把终态 discovery generation 定义为
`(repository, branch, current PR URL)`，使其区别于 PR 打开或不存在时使用的普通
`(repository, branch)` generation。进入终态时会因此产生一个从未刷新、立即到期的新 target。
成功的 discovery 可以沿用 fresh-meta 写回路径把 `closed` 校正为 `merged`，随后记录终态
fingerprint，使后续轮询再次停止。

没有把生命周期状态本身放进 fingerprint，因为从 `closed` 校正到 `merged` 会生成第二个
generation，并多发一次没有必要的请求。也没有按固定周期轮询所有终态 PR，因为完成这次
最终校验后，终态生命周期应保持稳定。

## 证据与验证

- `gh pr view 649 --repo LodyAI/Lody` 报告 `MERGED`，而截取的侧栏显示存储的 `closed` 图标。
- Target 回归测试复现了已有分支 fingerprint 抑制校验的问题。
- Scheduler 回归测试把已关联 PR 从 open 改为存储的 `closed`，让 branch discovery 返回
  `merged`，验证元数据得到校正，并推进 45 分钟以证明不会残留周期性终态轮询。

测试使用确定性的假时钟和合成 PR observation；它不会运行托管 webhook，也不会实时写入
会话元数据。
