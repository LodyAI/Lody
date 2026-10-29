# 在会话中显式展示停止异常

Status: implemented
Translation: current

[English](2026-10-29-session-stop-failure-notices.md)

## 摘要

Stop 取消未成功时可能继续持有执行占用，却只在后台日志中说明原因。
现在执行服务会在提供方取消请求失败、既有五秒排空期限到期、或强制终止失败时，
持久化一条会话警告。提示保留原始诊断，配有本地化说明，并按 assistant 回合与阶段去重。
提示写入不会阻塞清理，也不能授权复用未结束的执行；这些警告补充现有的
释放受阻恢复和遗留回合修复。

## 职责与行为

[释放所有者](2026-10-17-turn-release-survives-failure-handling.zh.md)已经把无法确认的
清理展示为 `releaseBlocked`，并允许等待中的输入请求恢复。
[遗留回合修复](2026-10-26-dead-turns-and-orphaned-queue.zh.md)已经允许重启后停止
无执行者的未结束回复。这些决策不要求提供方取消和排空失败只能写日志。
本次增加持久化诊断，不改变它们的执行和恢复保证。

- **触发：** 提供方拒绝取消请求、既有五秒排空期限到期，或取消期间终止失败。
  正常取消不产生提示。前端早期 RPC 超时仍不能判定停止失败，因为持久化投递可能成功。
- **所有者：** `SessionExecutionService` 判断当前 assistant 是否需要诊断，并抑制同阶段
  重复提示。已释放的执行者不能通过迟到的取消异常发出警告。MessageHandler 经过
  既有历史门控和 Session 后端写入器持久化。
- **取消与交接：** 警告写入独立于真实请求排空与终止。写入缓慢或失败都不能延迟强制
  清理、阻止已完成回合释放，或改变待处理输入策略。警告本身不会结束 assistant，
  也不会把用户回合标记为失败。
- **失败恢复：** 会话中显示失败阶段与原始错误。排空超时说明正在尝试强制结束；
  终止失败建议重启所属机器的后台服务。本次没有新增重试按钮，不保证终止成功，
  也不授权重放执行结果不确定的工作。

## 存储与展示

复用 `agent_warning` 现有的 `message`、`source` 字段。
`sessionCancelFailed`、`sessionStopTimedOut`、`sessionTerminationFailed` 分别选择
本地化标题与说明；旧客户端仍能展示通用警告。每条提示用 assistant id 和阶段组成身份。
停止诊断不参与整个会话按错误文本去重，后续回合发生相同错误时仍然可见。
展示继续复用渲染期折回所属回复、始终展开的现有提示条。

使用 `chat_failed` 会在生产者可能仍在运行时，把整段聊天表述成失败。
只返回 Stop RPC 失败既覆盖不了迟到的清理异常，也覆盖不了持久化元数据投递。
显式展示已有异常边界不需要新的状态协议或计时器。

Effect 迁移评估将本次保留在现有集成边界内：生命周期台账中的 Session 取消、ACP
传输、文档和历史所有权仍有未完成的 Promise 依赖，迁移整条链会扩大这处诊断修复。
本次不声称完成原生单元，也不改变台账。已有 Effect 取消 finalizer 使用
`Effect.tapError` 组合错误观察，继续复用已有排空期限。

## 验证与限制

执行回归使用真实 AgentClient、受控 ACP 传输、显式开始／完成信号和假时钟。
断言覆盖诊断阶段与原始错误、未结束历史与所有权的保留、清理未完成时不会提交第二条
提供方请求、重复 Stop 每阶段仅报告一次、迟到取消异常被忽略，以及提示写入等待或失败
时执行者仍能在真实工作结束后释放。MessageHandler 测试跨越真实 SessionDocument
写入器，确认警告持久化而不结束 assistant，也保留后续回合的相同错误文本。
渲染测试使用真实系统消息行，检查标题、恢复说明与完整原始错误直接可见。

对应测试位于
[`session-execution-service.test.ts`](../../../../apps/cli/tests/session-execution-service.test.ts)、
[`message-handler-turn-history-gate.test.ts`](../../../../apps/cli/tests/message-handler-turn-history-gate.test.ts)
和 [`chat-failed-detail-dialog.test.tsx`](../../../../packages/components/tests/chat-failed-detail-dialog.test.tsx)。
三种提示均有使用真实组件的
[Storybook 示例](../../../../packages/components/src/stories/AgentWarningNotice.stories.tsx)。

警告持久化尽力执行，存储本身失败时诊断仍可能只留在后台日志。
本次诊断改动的验证不包含真实操作系统进程终止和完整桌面重启。
