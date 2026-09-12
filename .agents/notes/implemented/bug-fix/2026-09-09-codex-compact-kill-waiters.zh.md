# Codex 进程退出时拒绝压缩完成等待

Status: implemented
Translation: current

[English](./2026-09-09-codex-compact-kill-waiters.md)

## 摘要

`/compact` 会等待 `thread/compacted` 通知。回合 waiter 在 Codex 进程退出时已经会 reject；压缩 waiter 只有 resolve，所以 `thread/compact/start` 之后进程一死，ACP prompt 一直占着，下一句变成 `already active`。这次宿主改动把 `acp-extension-codex` 钉到 `31c5ecc`（adapter #38，已 rebase 到包含 #30 的当前 adapter main），让 close/dispose 拒绝这些 waiter。健康压缩和回合中途杀进程的行为不变。adapter #38 尚未合入，在它合并前这个 pin 不能随桌面发布。

## 决策

- 宿主 gitlink `packages/acp-extension-codex` 从 main 的 `314b3823`（宿主 #275 / adapter 取消压缩）移到 `31c5ecc`（未合的 adapter PR #38，已 rebase 到含 #30 的 adapter main）。
- Core 和其它 submodule 保持当前 main。本 PR 不改它们。
- `runCompact` 仍然先登记 waiter，再用 `Promise.all` 同时等 start 和 completion，这样 vscode-jsonrpc 的 `close`（不会 reject 进行中的 start RPC）也能结束 prompt。
- 这不是 adapter #37 / Lody #544（fork 退订）。adapter #30（压缩过程中点停止）已在 adapter main，不是这次改动。

## 证据与限制

adapter #38 的独立审核使用真实 Codex 0.153.4 和合成模型 HTTP：compact-kill 在 10ms 内返回 ACP `-32603`，没有 `already active`；重启并 `loadSession` 后，历史回放、普通 prompt、再次 compact 均完成。生命周期 8/8 包含 start 仍 pending 时的真实 vscode-jsonrpc close。健康压缩和回合中途杀进程仍然完成。相关 adapter 回归 130 通过；已知 `/review` 斜杠命令超时在未改的 `400384e` 上就有，不当作这个 pin 的回归。

这不会发布 adapter。在 adapter #38 合入并且发行包含这个 gitlink 之前，桌面用户仍然会遇到该缺陷。这次宿主 pin 没有重新跑窗口内 Electron 的 compact-kill；验收是 adapter 协议加上宿主错误分类（`-32603` 应终止 adapter）。

相关：[adapter #38](https://github.com/LodyAI/acp-extension-codex/pull/38)、[adapter #37](https://github.com/LodyAI/acp-extension-codex/pull/37) / [Lody #544](https://github.com/LodyAI/Lody/pull/544)（已合，不是这次改动）。
