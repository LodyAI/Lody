# 按慢速 token 服务设定 GitHub 凭据截止时间

Status: implemented
Translation: current

[English](2026-10-15-github-credential-deadlines.md)

## 摘要

私有仓库的会话在第一个 prompt 之前就失败了，因为两种托管凭据来源都超时：broker
只给云端 token 请求 2.5 秒，Git/gh helper 只给 broker 3 秒，而宿主事件循环会卡顿
数秒。公开仓库会回退到匿名访问，掩盖了故障。现在云端截止为 15 秒、helper 等待
20 秒，内层请求总是先到期；验证探测也恢复到接近原来的预算。尚未测量托管 token
服务与本地卡顿各自占多少。

## 证据

2026-10-15 一个私有仓库的 Claude 会话在准备 worktree 时失败：`personal`/`app`
`acquire timeout`，`anonymous` `git_advertisement_failed`，随后
`credentials_exhausted`。当天 broker 记录了 82 次 `upstream_error`/`TimeoutError`，
耗时 2.6–3.6 秒，即 2.5 秒中止再加本地延迟。直接请求云端端点约 0.3 秒，GitHub
可达。daemon worker 平均约 50% CPU，事件循环监控报告 4.7–9.5 秒卡顿；5 秒以下的
卡顿不记录。同一时段的公开仓库会话成功。

## 决策

[身份回退](../architecture/2026-10-03-github-identity-fallback.zh.md)（#1224）引入了
2.5/3 秒这一对值，并缩短了相邻预算。两者只给 broker 处理留下 0.5 秒，即使云端按时
返回，一次短暂卡顿也会让 helper 放弃。每个来源仍只尝试一次、不重试。慢来源现在会
拖慢操作而不是让它失败，这比降级到低优先级身份或让会话准备失败更可取。

| 预算                            | #1224 之前 | #1224  | 现在  |
| ------------------------------- | ---------- | ------ | ----- |
| Broker → 云端 token RPC         | 无         | 2.5 秒 | 15 秒 |
| Helper → broker `/github-token` | 15 秒      | 3 秒   | 20 秒 |
| Git 访问通告探测                | 10 秒      | 5 秒   | 15 秒 |
| 原生 `git credential fill`      | 5 秒       | 3 秒   | 10 秒 |
| SSH `ConnectTimeout`            | 5 秒       | 3 秒   | 10 秒 |
| gh `auth token`                 | 5 秒       | 3 秒   | 10 秒 |

云端截止改为 unref 的计时器，同样覆盖响应正文，便于用假时钟测试。broker 会记录耗时
2 秒及以上的成功请求，使余量缩小在变成失败之前就可见。

## 验证与限制

所属测试覆盖：10 秒响应成功、挂起请求在截止时中止、调用方取消，以及云端截止小于
helper 截止。helper 脚本的预算是插值常量；派生脚本的测试不会真实等待数秒。
`clones recursive native SSH submodules while cloud credentials fail` 在本 Lody
托管环境中于未修改的基线上同样失败（`context_unreadable`）。未区分托管延迟与本地
卡顿；事件循环卡顿本身仍未修复。
