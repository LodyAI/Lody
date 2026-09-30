# Agent 角色可到达执行机器所有者可用的任意机器

Status: implemented
Translation: current

[English](2026-09-28-mcp-cross-machine-agent-role.md)

## 摘要

当 Agent 被要求与另一台机器上绑定的角色协作时，会被 `AGENT_ROLE_MACHINE_MISMATCH`
拒绝，随后它在那台机器上启动了一个没有角色的 Agent，角色的提示词与运行配置因此被静默丢弃。
三处都在执行过时的单机规则：MCP 创建、MCP 资源发现，以及输入框的角色提及，都把普通聊天或
本地项目固定在本机；代理访问检查只接受执行机器所有者名下的机器。现在角色可以从任何上下文
派发到该所有者可用的任意机器：其名下的机器，或已共享的机器；共享机器上的本地项目也必须已共享。
驱动这轮对话的人也必须能使用目标机器，代理调用不会扩大任何一方的权限；新的托管端查询会同时检查两位用户。

## 发现

`apps/cli/src/mcp/lody-mcp-server.ts` 中的 `resolveMcpSessionCreate` 会拒绝其他机器上的角色，
除非发起方位于 GitHub 项目，这是角色 V1 设计（#135）的规则。[提及 Spec](../../../../specs/agent-role-mentions.md)
与[提及可用性说明](../feature/2026-09-09-agent-role-mention-availability.zh.md)后来把普通聊天
扩展到所有有权限的机器（#548），但 MCP 检查和资源发现的 `roleMachineScope`
（`outside_work_context`）没有同步。该错误不可重试，调用方 Agent 于是改用手动
`machineId + agentConfigId` 创建，而这条路径不携带角色。

MCP 以代理请求方身份运行：daemon 的 CLI token 属于执行机器的所有者，驱动这轮对话的人来自
Turn。代理路径调用托管端的 `canUseMachineFromCliToken`，它原本用于执行 daemon 核验本机上的
请求方，因此要求目标机器归 token 用户所有。于是同事已共享的机器，即使对其本应可用的用户，
也无法到达。

## 决策

- **可达范围。** `readDelegatedMachineAccess`（`apps/cli/src/commands/session.ts`）调用在
  `packages/cloud-api` 中声明的托管端查询 `canDelegateMachineUseFromCliToken`。服务端认证 token
  用户，并对该用户和驱动者分别执行同一套机器规则（名下，或已共享机器加已共享项目，以及工作区
  成员资格），不带服务所有者条件；两者都必须通过。所有代理入口都使用该函数：创建校验、
  `lody_session_create_options` 的机器与本地项目、资源发现。
- **灰度兼容。** 后端尚无该查询时（Convex 报告找不到公开函数），CLI 保留保守的两步回退：先以
  token 用户调用 `canRequestMachineFromCliToken`，驱动者不同时再调用 `canUseMachineFromCliToken`。
  该回退无法在所有者不拥有的机器上检查驱动者，因此在后端上线前拒绝这种情况。
- **目标机器。** 执行 daemon 仍用自己的 `verifyMachineAccess` 核验 Turn 的发起人，本次不放宽。
- **角色落点。** 删除 MCP 机器检查和资源发现的工作上下文范围。子会话必须与父会话同机，因此本地
  项目发起方只有在角色同机时才默认创建子会话；其他机器上的角色在自己的机器上独立启动，使用作为
  `workContext` 传入的本地项目，或作为普通聊天。对远端角色显式要求子会话时，仍以现有的父机器
  错误拒绝。
- **输入框提及。** 所有输入框都使用有权限机器范围；删除 `outside_work_context` 原因及固定机器的
  辅助函数。

被否决的方案：保留本地项目限制（负责人要求角色处处可调用，而独立会话是那里的有效形态）；只检查
驱动者（daemon 可以声称任何同事，因此必须用执行机器所有者的权限约束代理）；在 CLI 中依据
`MachineMeta.ownerUserId` 判断第三方场景（该字段来自未经认证的同步文档）。

## 限制

托管端查询部署前，驱动他人共享机器的同事仍无法通过 Agent 到达第三人的共享机器。选择回退的
`Could not find (public )?function` 匹配依据 Convex 文档中的服务端错误，尚未在真实的旧版部署上
观察到。

## 验证

- 私有后端的 `machines.test.ts` 覆盖托管端查询：名下、共享、未共享和共享项目目标，同事到达第三人
  的共享机器，任一方都无法借用另一方的私有权限，以及非成员驱动者。去掉任一用户的检查都会使测试
  失败。
- `apps/cli/src/commands/session.test.ts` 对托管路径和回退路径运行相同场景；忽略托管端结果会使
  第三方同事场景失败。
- `apps/cli/src/mcp/lody-mcp-server.test.ts` 覆盖聊天发起方将远端角色解析到其自身机器，以及本地
  项目发起方仅对同机角色默认创建子会话；回退修复后两者均失败。
- CLI 类型检查与范围 lint 通过。
