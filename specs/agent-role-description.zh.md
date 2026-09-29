# Agent Role 描述

Status: draft
Translation: current

[English](agent-role-description.md)

Role 所有者可以填写可选描述，说明其他 agent 应在什么情况下调用它。
编辑器显示相应提示，并将输入（包括粘贴）限制为 140 个 Unicode 码点。
描述与提示词前缀分开：它属于发现元数据，不会作为指令加到新会话前面。

描述保存在现有工作区 Role 行中，遵循现有可见性规则出现在 Role 发现的
list/get 结果中。旧客户端没有该字段时读取为空，不迁移、不提升格式版本。
空描述和缺失描述在无变化保存时等价；修改或清空描述通过现有编辑路径推进
Role revision。

实现依据：`packages/shared/src/agent-role.ts`、`packages/components` 中的
Role 编辑器及表单辅助函数，以及 `apps/cli/src/lib/resource-discovery.ts`。
