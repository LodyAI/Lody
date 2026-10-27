# MCP 侧栏子对话创建指引

Status: implemented
Translation: current

[English](2026-10-27-mcp-session-placement-guidance.md)

## 摘要

MCP 创建文案把 Tab 包含关系称为“child”，容易与侧栏子对话混淆。
单个和批量创建工具现在要求 agent 默认显式传入
`useCurrentSessionAsParent=false`，仅在用户明确要求 Tab 时使用 `true`。
本次只修改调用指引，保留既有运行时默认行为。

## 决策与限制

工具描述和发布的参数描述都包含此规则。显式 `false` 很重要：同机器本地项目的
Role 创建在省略此字段和 `workContext` 时可能推断为 `true`。批量指引将该值放入
`defaults`，单项可按用户明确要求选择 Tab。独立对话仍可通过 `workContext` 选择项目。

[MCP README](../../../../apps/cli/src/mcp/README.md#session-placement-guidance)
记录此行为，与[会话关系](../../../../specs/session-relations.md)一致。
未修改分发、参数接受范围或运行时默认值。验证覆盖格式和文档；agent 实际遵循情况
需要真实使用观察，不宣称已测得效果。
