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

同一修复还将 pre-prompt 进程处置与 pending-input 策略分开，并使部分 promotion 可恢复，
让 Edit & Resend 保住 prepared ACP 资源，避免 activation 写入失败卡住已经 pending 的输入。

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

### 修正：进程 ownership 与部分 promotion

无条件丢弃所有已 bind 的 pre-prompt Session 会杀掉 Edit & Resend 已准备的 replacement。
取消现在独立选择 `prePromptSession`：Stop 和访问撤销使用 discard，Edit & Resend 使用 keep。
create/restore 原有的取消 fence 保护尚未完成的初始化，完成后释放，不覆盖配置阶段后续的 keep。

promotion 原先在历史已变成 pending 后吞掉 activation 写入失败。CLI 现在报告
`promotion-failed`，不得把存储失败改判为 provider 投递未知。客户端对 pending/seen 与
pending_apply 都可修复普通 dispatch，也支持旧的 no-active-turn 响应；active、terminal
及已删除的轮次保持不变。

### 修正：Codex 模糊响应补查

adapter #43 修正了外层 catch，但内层提交 catch 仍把 turn 结束当作未投递证明，并在 drain
通知前删除 steer 身份。[adapter 后续修复 #44](https://github.com/LodyAI/acp-extension-codex/pull/44)
让 in-flight 身份保留到 prompt cleanup 之后，对失败响应
使用已收到的通知及一次 `thread/read(includeTurns: true)` 补查。只有原 thread、原 turn
中带同一 `clientId` 的 user item 才能证明 applied；实时和历史证据共用一次 acknowledgement，
并在 steer 响应结束前发送。明确拒绝仍可安全重放；未找到、读取失败或不支持、超时及 Stop
本身都不能证明未投递，仍保留 unknown。

补查限时五秒，不重发、不 resume、不启动 turn。这只是用正面证据缩小模糊投递范围，
不承诺幂等、历史负面证明、跨重启恢复，也不保证恢复成功响应之后丢失的每一条实时通知。
正常成功响应路径保持不变。

## 证据与边界

行为测试覆盖 Codex `not-applied` 提升、晚到 `applied`、内部取消保持，以及两次配置 mutation
之间的 Effect 中断。本次不新增持久化 hold 状态，不暂停 Goal 或 Operation，也不定义 durable
Resume。
配置 race 测试将真实 Session termination、Edit & Resend 和 execution service 连起来，
只通过显式信号控制 ACP/OS 边界，验证退出前 ownership、client 清空及 replacement 在原进程
内使用，同时覆盖 resident 与刚 restore 完的 session。故障注入覆盖历史 promotion 成功后
activation 写入失败，以及客户端 dispatch 修复。
这是确定性的生命周期测试，并非连接真实 provider 的端到端运行。

adapter 回归测试使用真实通知路由及 prompt cleanup，只控制 app-server 响应：覆盖 prompt
结束后 ACK 丢失、排队及晚到通知、精确身份匹配、不可用或晚到历史，以及补查中的 Stop。
计时使用 fake timers，生命周期顺序使用显式信号。历史命中证明投递，不代表执行完成。
