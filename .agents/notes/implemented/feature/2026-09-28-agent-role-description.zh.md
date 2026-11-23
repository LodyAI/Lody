# Agent Role 描述元数据

Status: implemented
Translation: current

[English](2026-09-28-agent-role-description.md)

PR: https://github.com/LodyAI/Lody/pull/1092

## 摘要

Role 原本有名称和执行提示词，但缺少简短的调用时机说明。现在可选描述通过
现有目录和发现结果传递，限制为 140 个码点，并提供本地化的编辑提示。
旧数据读取为空，描述修改沿用现有 revision 规则。该字段不改变执行提示词，
也不引入存储迁移。

## 决策与依据

共享规范化函数按 Unicode 码点限制描述长度，避免拆开 emoji。编辑器在输入和
粘贴时应用同一限制，表单保存及目录读取也会限制长度。缺失与空描述比较时等价，
避免打开并保存旧 Role 时产生无意义的新版本。

发现结果公开描述，让 agent 可以按用途选择 Role。可见性及目标检查继续遵循
[目录说明](../../../docs/workspace-catalog-durability.md)。新的
[描述 Spec](../../../../specs/agent-role-description.zh.md) 记录新增意图；现有
[提及可用性决策](2026-09-09-agent-role-mention-availability.zh.md) 继续约束提及行为。

行为测试扩展共享 Role、表单及资源发现测试集，覆盖旧数据空值、Unicode 长度限制、
修改、清空、版本变化及发现结果。
