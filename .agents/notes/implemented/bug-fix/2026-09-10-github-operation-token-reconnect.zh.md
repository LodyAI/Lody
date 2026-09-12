# 静默恢复 GitHub 操作令牌的 Convex 断线

Status: implemented
Translation: current
PR: not created

[English](2026-09-10-github-operation-token-reconnect.md)

## 摘要

用户点击合并 Pull Request 时，客户端可能在取得 GitHub 操作令牌的 Convex Action 期间断线。此时尚未向 GitHub 发出合并请求，但界面会把底层连接错误显示为“合并失败”。令牌请求现在会静默重试一次；若重试仍收到同一断线错误，合并按钮恢复可用且不显示该技术错误。GitHub 已返回的真实合并失败仍会照常提示，重试次数保持为一次以免在网络持续不可用时隐藏无限等待。

## 决定与范围

- 仅重试 `Connection lost while action was in flight`，并且仅作用于获取操作令牌；它发生在 GitHub 写操作之前，重复请求不会重复合并。
- 重试耗尽后只抑制这条 Convex 传输错误的合并 toast；请求仍被分析事件记录，其他令牌、权限和 GitHub 合并错误仍显示给用户。
- 不查询 GitHub 的合并状态：该错误点在 GitHub 合并请求之前，因此不存在“已合并但客户端未知”的状态。

## 证据与限制

令牌单测覆盖断线后重试成功，PR 容器测试覆盖耗尽后不显示 toast。此变更不证明特定用户的网络、代理或 Convex 服务端为何断开；持续断线时用户可再次点击合并。
