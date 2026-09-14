# 中断时 pending input 的 exactly-once

Status: implemented
Translation: current
PR: [#693](https://github.com/LodyAI/Lody/pull/693)

[English](2026-09-14-interrupt-pending-input-exactly-once.md)

## 摘要

停止 turn 时，通用取消状态无法安全判断同时提交的 steer 是否已经进入 provider，因而重放风险与
输入丢失被错误地绑定在一起。本次修复让 adapter 返回三态投递结果，并让取消显式携带
pending-input 策略。用户 Stop 只提升已证明 `not-applied` 的 steer；内部取消和未知投递保持原状。
durable Session hold、Goal hold、Operation hold 和 Resume 明确不属于本决策。

## 决策

`AgentClient.steerPrompt` 将投递结果解析为 `applied`、`not-applied` 或 `unknown`。Codex adapter
显式返回的 `failed` 以及写入前的同步失败可以证明 `not-applied`；连接和进程失败不能。
`SessionExecutionService` 不检查 provider 异常类型来重新分类投递结果。因此 Codex adapter 只在
可证明拒绝投递时返回 `failed`；未知 adapter 错误会 reject request，并保持为 `unknown`
（[adapter PR #43](https://github.com/LodyAI/acp-extension-codex/pull/43)）。

`cancelSession` 默认使用 `pendingInput: 'preserve'`。面向用户的 Stop 路径显式选择
`'promote'`；Edit & Resend 和访问撤销保持 `'preserve'`。被提升的用户轮次复用已有普通
dispatch pointer 和历史状态，不新增第二条执行路径。晚到的 `applied` 和 `unknown` 结果绝不
发布该 pointer。

foreground ACP run configuration 接收 owner Effect 的 `AbortSignal`。配置代码在 mutation
之间以及持久化 runtime patch 前检查该 signal，防止已中断 turn 在后继 turn 启动后继续发送
后续 mutation。

## 证据与边界

行为测试覆盖 Codex `not-applied` 提升、晚到 `applied`、内部取消保持，以及两次配置 mutation
之间的 Effect 中断。本次不新增持久化 hold 状态，不暂停 Goal 或 Operation，也不定义 durable
Resume。
