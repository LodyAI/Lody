# 原生端提议卡片与 Agent 文件卡片

Status: implemented
Translation: current

[English](2026-11-11-mobile-proposal-cards.md)

## 摘要

Web 端会把 Agent Role 提议、定时任务提议和 Agent 分享的文件渲染为卡片，但原生 iOS 显示为通用“会话事件”行、Android 直接丢弃，因此在手机上进行的对话里无法确认提议。共享云端 runtime 现在会投影格式正确的提议，并新增 `decideProposal` 命令：保存 Role 或创建定时任务，并把结果写回提议通知；两端基于它渲染卡片。该命令复用 runtime 已有的 Agent Role 与定时任务写入路径，而不是移植 Web 的整轮替换。Android 暂无会话文件下载，因此其文件卡片只展示信息。

## 决策

runtime 的 `protocol/proposals.ts` 把 `agent_role_proposal` 与 `schedule_proposal` 的 meta 读成有界的展示结构（系统通知摘要上的 `proposal`）；格式不正确时仍是普通通知。`decideProposal` 遵循 Web 的 [Role 提议](2026-10-17-agent-role-proposals.zh.md)规则：只有发起者能决定 Role 提议，重复创建保留已有 Role，更新只通过既有 `roleSettings` 写入提议的字段。定时任务遵循 Web `resolveScheduleProposalTarget`：默认沿用对话的 Agent、模式和项目，提议指定 Role、Agent、电脑或项目时只覆盖对应部分；换了 Agent 时使用 Lody 内置默认模式，并检查电脑所有者与定时任务协议支持。提议 id 即定时任务 id，活动 id 为 `proposal-<id>`，重试创建不会产生两个任务。

结果通过在已打开会话文档中设置通知 `meta` 字段并追加更新写回，与权限应答同一路径。追加失败时版本保留在 `unsent` 中，投影会隐藏未确认的结果，卡片保留按钮供用户明确重试；不会自动重放。Web 卡片内的定时任务编辑未移植，需要修改规则时在创建后编辑任务。

定时任务修改提议（`schedule_edit_proposal`，来自 LodyAI/Lody#3181）复用同一命令：`inspectProposal` 读取实时任务并与提议比对（已删除、`baseActivityId` 之后被修改、所有者、电脑能力、Agent 是否存在），返回提示词逐行差异；接受时在实时任务上写入提议字段，活动 id 使用 Web 的 `scheduleEditProposalActivityId`，因此任一端重试都会重放同一次保存。同一投影还携带 Web 的其他系统行（Agent 警告、分叉来源、恢复聊天记录、worktree 脚本）；未知通知名与 Web 一样隐藏，不再显示为通用事件。

## 影响

Android 内置 runtime 快照已更新以包含新投影和命令，并通过桥接暴露 `decideProposal`。iOS 上已创建任务的卡片可打开定时任务页；Android 只显示回执。iOS 上 Agent 文件像附件一样可打开；Android 显示名称、类型和大小。

## 验证

`pnpm contract:check` 保持 Swift 合约与 runtime 方法一致。`apps/mobile/ios/apps/ios/tests/schedules/edit-proposal.test.mjs` 在内存定时任务流上驱动修改提议的 `inspectProposal` 与 `decideProposal`。iOS `proposal-cards` UI 用例与 Android `SystemCardsDeviceTest` 使用合成的 runtime 结果渲染卡片；Role 与定时任务创建路径仍没有 runtime 级测试。
