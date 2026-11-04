# Agent Role 多机器配置

Status: draft
Translation: current

[English](agent-role-machine-targets.md)

## 场景

有多台机器的用户希望同一个 Role（比如 Reviewer）在每台机器上表现一致。过去一个
Role 只能绑定一组 `machineId + agentConfigId`，而且名称必须唯一，于是同一个 Role
只能拆成 `reviewer-mac` 和 `reviewer-linux`，每次改提示词都要逐台机器重复。本 Spec
让一个 Role 可以带多个机器配置（machine target）。

## 决策

Role 分为两层。名称、emoji、描述、提示词前缀和可见范围由所有机器共享。每个
**机器配置**各自拥有 Agent Config、模型、模式、运行选项和记忆体绑定；Role 有多份
配置时，每份还可以设置别名。每台机器在一个 Role 下最多一份配置。配置顺序只是添加
顺序，不代表优先级，各配置之间也不会互相兜底。

Role 编辑器在提示词下方显示机器 Tab：先是 Role 已有的机器，再是用户能访问的其他
机器。Role 尚未运行的机器显示“添加到此机器”。添加时，会预选这台机器上与第一个已
配置机器 agent 类型相同的 Agent Config，名称相同的优先（自定义 agent 按名称匹配）。
运行配置按原样复制；目标 agent 不支持的部分会在保存前作为问题列出，不会被悄悄丢掉。
记忆体放在机器 Tab 内，因为记忆关联和 Provider 数据都属于具体机器：添加时预选这台
机器上 Provider 和记忆 ID 都相同的关联，没有则保持未关联。不同机器上的记忆分开存储，
Lody 不会合并。删除某台机器的配置不影响其他机器的配置和共享字段。

设置页把所有 Role 放在一个列表里，每行在任何状态下高度一致：左侧是名称、标记和运行
摘要，右侧一列是运行的机器。每台机器带状态点，超过两台时折叠为“+N”；若 Role 在用户能
访问的所有机器上运行，则显示“全部 N 台机器”。各机器运行方式相同时只显示一次运行摘要，
否则显示“各机器配置不同”。绑定问题把对应机器标为警告色并在悬停时说明原因，不额外占一行。

## 提及与派发

`@` 菜单为 Role 的每个机器配置各显示一行，一步选完。只有一份配置的 Role 和以前一样
显示名称。有多份配置时，每行显示别名；未设置别名时显示 `名称 · 机器名`；同一个 Role
内，当前输入框所在机器排在最前。其余的可用性、禁用原因和排序沿用
[提及规则](agent-role-mentions.md)，按每个机器配置分别判断。输入框自己的 Role 选择器
本来就限定在一台机器上，会按那台机器的配置提供每个 Role。

提及记录携带 Role ID；多机器 Role 还会携带机器 ID。多机器 Role 的提及若只有 Role ID，
就没有指明机器，发送时保持纯文本。被接受时，解析出的机器配置（机器、Agent Config、
运行配置、记忆体）连同共享提示词和 revision 一起固定下来，与以前单机 Role 的固定方式
一致。别名与 Role 名称一起参与提及 token 的唯一性检查。

Agent 在创建工具中用 `agentRoleMachineId` 指定机器；CLI 使用 `--machine` 或别名。
多机器 Role 未指定机器时报错并列出它的机器，绝不自动选择。定时任务提案指定多机器
Role 时，使用提案中指定的机器；未指定时，若 Role 在提案所在会话的机器上运行就用那台，
否则要求指定机器。

## 兼容性

新客户端读取所有现有（v1）Role：v1 Role 视为只有一份配置的 Role。只有一份配置的
Role 继续以 v1 结构写入，包括自动 [schema 对齐](agent-role-schema-reconciliation.md)
时的写入，所以升级不会改变它们。只有当 Role 有多于一份配置时才以 v2 结构写入。旧
客户端和旧 CLI 只接受 v1，因此不会显示或编辑 v2 Role，也不可能覆盖它的多机器配置。
除此之外不再为旧客户端提供兼容。配置删减回一份时，Role 恢复为 v1 结构并去掉别名。

已固定的 turn、Operation 和 Session 来源信息保持原有结构，恢复和历史不依赖 Role
记录的版本。

## 待定问题

- Agent 只给出 Role id 派发时，是否可以像输入框排序那样，默认使用派发方 Session
  所在机器的配置，而不是总要求 `agentRoleMachineId`。
- 添加机器时是否还要提供“在这台机器上创建相同 ID 的记忆身份”；目前需在记忆设置中
  关联。

## 依据

- [Role 模型、记录结构与绑定](../packages/shared/src/agent-role.ts)
- [表单模型与添加机器建议](../packages/components/src/lib/agent-role-form.ts)
- [Role 编辑器](../packages/components/src/components/settings/agent-role-editor-dialog.tsx)
- [Role 列表](../packages/components/src/components/settings/agent-roles-setting.tsx)
- [提及条目](../packages/components/src/components/mentions/mention-agent-role-source.ts)
- [CLI 与 MCP 解析](../apps/cli/src/lib/agent-role-create.ts)
- 行为测试：`packages/shared/tests/agent-role.test.ts`、
  `packages/shared/tests/workspace-flock.test.ts`、
  `packages/components/tests/agent-role-form.test.ts`、
  `packages/components/tests/agent-role-row.test.tsx`、
  `packages/components/tests/agent-role-mention-source.test.ts`、
  `packages/components/tests/use-agent-role-schema-reconciliation.test.tsx`、
  `apps/cli/src/lib/agent-role-create.test.ts`
