# 避免 Session 命令诊断日志污染结构化 stdout

Status: implemented
Translation: current

[English](2026-10-16-session-structured-stdout.md)

## 摘要

Session 取消可能已经成功，但 workspace 清理在 JSON 回执之后向 stdout 写入日志，
导致 MCP 调用方收到不可重试的 JSON 解析错误。公共 Session 命令入口现在在 JSON 和
JSONL 模式下，将初始化、执行、清理和退出刷新期间的诊断日志统一路由到 stderr。
该修复复用已有的观察命令机制，不放宽 MCP 解析规则，也不改变取消语义。
独立行为检查通过；当前 checkout 缺少依赖，仓库测试套件尚未验证。

## 决策与证据

[Issue #1604](https://github.com/LodyAI/Lody/issues/1604) 指出了尾部 transport-detach
日志。`withWorkspaceManager` 先等待回调完成，再清理资源，而回调已经打印回执。
`runLodyCliJson` 等待进程关闭后解析 stdout 最后一行。归档路径存在同类问题；
Operation 取消通过 `allSettled` 吸收目标取消失败，因此其成功响应不能证明 CLI
解析正常。

[runSessionCommand](../../../../apps/cli/src/commands/session.ts) 统一拥有结构化
日志作用域，并在 `finally` 恢复路由；作用域包含错误回执和退出刷新。
Observe 复用此公共边界，移除自身的重复包装。普通文本模式保留原有日志路由。
保持解析严格：搜索任意有效 JSON 会掩盖 stdout 污染，还可能误选其他 JSON 日志。
仅降低某条日志等级无法防止其他日志或 debug 模式再次触发问题。

本次扩展了[观察命令决策](../feature/2026-10-08-cli-session-observe.zh.md)。
不包含原生 Effect 迁移：修复只调整既有 Promise 命令所有者周围的同步日志路由；
迁移 workspace 获取与清理会涉及与本输出缺陷无关、尚未完成迁移的依赖。

## 验证与限制

既有 Session 测试套件新增真实日志输出流和 workspace-manager 清理验证，覆盖结构化
成功及错误输出、退出日志、普通文本输出与路由恢复。替换时间同步和遥测边界，避免
网络及进程副作用。测试执行被缺失的 Vitest 阻塞；`pnpm check` 被缺失的 TypeScript
工具阻塞。

独立验证程序执行当前命令入口与控制台日志源码，使用锁定版本 Winston 3.19.0 和
合成初始化、退出边界：JSON、JSONL、普通输出各自成功及失败，共六个场景通过。
移除新增路由后重新触发解析错误。这不等同于完整模块集成测试或认证 CLI/MCP 端到端
测试。修改的 TypeScript 文件使用 Oxfmt 0.65.0 格式化。既有文档检查存在子模块缺失
造成的断链。
