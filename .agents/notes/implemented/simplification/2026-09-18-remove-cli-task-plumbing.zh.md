# 移除 CLI Tasks 产品接线

Status: implemented
Translation: current

[English](2026-09-18-remove-cli-task-plumbing.md)

相关：[工作区 Tasks 产品](2026-09-18-remove-legacy-tasks.zh.md)

PR: https://github.com/LodyAI/Lody/pull/800

## 摘要

Lody Tasks 产品文档与 MCP 工具已经删除，但 CLI 的会话调度、fleet 自动化、同步/导出
以及 MCP 仍在依赖它们。本次移除剩余的 `lody_task_*` 工具、`taskToolsEnabled` 门控、
会话 `--task` 关联、委托任务自动化，以及 sync/export 对任务的枚举，使公开 CLI
不再依赖 Tasks 产品即可编译。ACP 子 Agent 任务通知与 scheduled-tasks-from-history
保持不变。共享历史仍可解析遗留的 `task_proposal` 通知；CLI 不再写入或发布 Task 工具。

## 决策

内置 Lody MCP 在 stdio 与 HTTP 上都不再注册 Task 工具族。会话启动不再携带
`taskToolsEnabled`、对应 HTTP 头或 `LODY_MCP_TASK_TOOLS_ENABLED` 环境变量。Create
不再继承或写入 `taskId`，fleet 也不再启动委托任务自动化。`lody sync` 与
`lody export` 停止列出 Task 房间或写出任务产物；导出示意文件保留 `taskCount: 0`
以维持既有形状。已存储 Operation 的调度配置仍可能带有旧门控字段；恢复时剥离该字段
而不是拒绝整行。

## 验证

`pnpm --filter lody typecheck` 已通过。覆盖 MCP、会话 create/chat 调度、session
manager、fork、execution、fleet catalog、operation store 与 sync helper 的 Vitest
共 371 个用例通过。`pnpm run docs check` 对本笔记语言对未报错误。
