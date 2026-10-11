# Review agent 移除

Status: draft
Translation: current

[English](review-agent-retirement.md)

用户打开实验设置、Provider 设置或会话菜单时，不再看到 Review agent、
Review this branch 和 Auto review and merge。此次删除整个实验功能，
并非将自动审查改为默认可用。Roost history 保持原有的实验开关。

Daemon 不再启动、恢复或推进自动审查，包括曾通过 `SessionMeta.autoReview`
授权的任务。此功能不再创建 reviewer 会话、派发修复轮次或自动合并 PR。
MCP 不再公布 `lody_review_submit`。

保留历史会话元数据和 workspace 的 review 文档，不迁移或删除它们。
旧 `autoReview` 指针不再生效，也不阻止 Edit & Resend。已有 reviewer 会话
仍是普通会话；不通过数据迁移取消已经执行中的 agent turn。
这些保证适用于更新后的 daemon；旧版 daemon 在升级或停止前仍按旧逻辑运行。

手动 PR 操作、review threads、会话委派和计划任务保持原有行为。
共享的 PR 和 commit prompt 继续供手动快捷操作使用。

## 证据

- [Daemon 组合](../apps/cli/src/lib/lody-fleet.ts)
- [MCP 目录](../apps/cli/src/mcp/lody-mcp-server.ts)
- [会话元数据](../packages/shared/src/schema.ts)
- [手动 PR prompt](../packages/shared/src/pr-prompts.ts)
- [Edit & Resend](../apps/cli/src/session/session-edit-and-resend-service.ts)
