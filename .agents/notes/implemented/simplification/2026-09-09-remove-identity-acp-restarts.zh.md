# 身份变更时保留 ACP 进程

Status: implemented
Translation: current

[English](2026-09-09-remove-identity-acp-restarts.md)

## 摘要

此前身份变更会在恢复 provider 会话之前杀掉常驻 ACP 及其 sandbox，带来启动延迟，并在请求者
切换时破坏运行时状态。本次回滚为「继续使用」与「领用已预备会话」两条路径移除了该行为，同时
保留 owner/requester 的身份解析策略。宿主侧的环境更新仍然保留；如何在不重启的情况下把它们
传播进既有 ACP，是一个尚未解决的限制。

## 决策

本记录部分取代了
[machine owner identity](../feature/2026-09-08-machine-owner-git-identity.md)中的重启
决策，该决策由 [PR #521](https://github.com/LodyAI/Lody/pull/521) 合入。进程连续性优先于
通过替换进程来强制传播身份。移除启动快照、restart-return 契约以及无人使用的内部终止 API；
保留常规终止路径。

在另一个请求者接手之后，由 owner 启动的 ACP 可能继续以其启动时的身份执行 adapter 拥有的
Git 命令。宿主侧的身份解析仍然不会为非 owner 回退到机器配置。未来的实时传播方案必须在不
重启 ACP 与 sandbox 的前提下弥补这一缺口。

## 验证

回归覆盖验证了请求者切换会向既有 ACP 发起 prompt，且身份变化会保留已领用的预备会话。两条
路径都不得创建替代运行时。
