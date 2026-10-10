# 进程 Scope 释放失败

Status: draft
Translation: current

[English](process-scope-release.md)

## 场景与责任

拥有者完成或取消有 Scope 所有权的进程工作，但有界终止无法证明进程树已消失。即使 body 成功，Scope 也必须报告失败；记录日志不代表释放成功。

进程后端通过 Scope 失败中的恢复租约保留未解决的进程树。接收方保留租约，直到存活探测确认不存在，或另一次有界终止成功。重试失败保留所有权；优雅重试等待期间可以强制终止。观察到不存在后租约退役，后续调用以及并发重试的轮询不能向使用相同数字标识的新一代进程发信号。尚未观察到不存在之前的标识复用不在此保证内。

超时或 body 错误可以与释放失败同时发生。Promise 兼容边界必须同时保留全部恢复租约和主要失败。再次调用 Scope.close 不能重试清理。确认进程树不存在不代表 stdio 排空、文档 flush 成功或会话、daemon 完整关停。按现有进程契约，成功命令保留刻意留在后台的 helper。真实 Windows 根退出后的后代需要单独的所有权工作。

## 证据

- 实现与测试：`packages/shared/src/node/process.ts`、`packages/shared/tests/process.test.ts`。
- [决定](../.agents/notes/implemented/bug-fix/2026-10-10-effect-process-release-failure.zh.md)。
- [进程边界规则](../packages/shared/src/node/AGENTS.md)。
