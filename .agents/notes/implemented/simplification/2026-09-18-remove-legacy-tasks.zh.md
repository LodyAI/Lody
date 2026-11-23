# 移除工作区 Tasks 产品

Status: implemented
Translation: current

[English](2026-09-18-remove-legacy-tasks.md)

相关：[CLI 接线](2026-09-18-remove-cli-task-plumbing.md)

PR: https://github.com/LodyAI/Lody/pull/800

## 摘要

公开桌面端移除了 beta 工作区 Tasks 看板、`lody_task_*` MCP 工具、任务文档以及
与会话挂钩的自动化。遗留的 `task-<id>` 房间、Task Index Flock 文档、已存储的
`task_proposal` 通知，以及旧的 `taskToolsEnabled` / `SessionMeta.taskId` 键仍可
读取并保持休眠，以便账号删除与历史解析继续工作。Codex 计划任务、ACP 子 Agent
任务通知，以及侧栏里名为 “My Tasks” 的会话列表属于另一套产品，予以保留。

## 决策

产品 UI、路由、hooks、beta 开关和 MCP 工具是删除而不是隐藏。共享包保留极小的
遗留 id 模块（`TASK_DOC_PREFIX`、`getLoroTaskStreamId`、`getTaskIndexFlockDocId`），
让剩余 CRDT 房间仍能映射到 stream。历史写入器仍解析 `task_proposal` 通知，使旧
会话可以打开；但不再发布或确认它们。对话渲染器丢弃该通知名，而不是显示通用卡片。
分享导出继续剥离这些通知。sync 与 export 停止枚举 Task 房间。托管的 task-image
路由和 Convex 清理副本不在本仓库。

曾考虑保留一段弃用窗口，但该功能处于 beta 门控，留下 MCP 工具或路由只会让死表面
继续在线，因此放弃。

## 验证

删除产品文件后，针对共享历史、MCP 目录和渲染器 writer 做了类型检查与聚焦测试。
此嵌套 worktree 没有 `node_modules`，因此没有运行 `tsr generate`；改为编辑
`routeTree.gen.ts` 去掉 Tasks 文件路由。托管账号删除 dry-run 不在本仓库范围内。
