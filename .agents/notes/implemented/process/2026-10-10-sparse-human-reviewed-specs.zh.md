# Spec 只记录需要重要人工评审的决定

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1398

[English](2026-10-10-sparse-human-reviewed-specs.md)

## 摘要

原有宽泛指令把行为变化当作 Spec 触发条件，在已经足够的 README 和 Note 之外，
又创建了独立的查询重试 Spec。现在 Spec 只用于需要人工评审的重要决定，或明确
要求编写的规格。优先更新现有归属，新 Spec 只保留决定及必要保证。普通实现行为
记录在所属文档中。

## 决定

此次收紧[指令归属决定](2026-09-08-scoped-agent-instructions.zh.md)保留的 Spec
触发条件，同时保留[Note 触发规则](2026-09-07-explicit-agent-note-triggers.zh.md)、
双语维护和每个评审版 Spec 的批准要求。根指令和收尾流程统一遵循
`specs/AGENTS.md` 的选择规则；Note 不再隐含需要配套 Spec。

删除本 PR 新增的查询恢复 draft 双语文件。实现细节保留在现有 hook README 和
恢复 Note 中，并修复引用。未改其他 Spec 或产品行为。文档及格式检查通过；
此次仅改文档，不重跑应用测试。这些检查不能证明后续决定是否满足此门槛。
