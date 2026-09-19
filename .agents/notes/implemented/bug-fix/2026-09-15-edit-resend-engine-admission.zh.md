# 编辑后重发在引擎占用 ACP prompt 时 fail closed

Status: implemented
Translation: current

[English](2026-09-15-edit-resend-engine-admission.md)

## 摘要

一次 review 指出一个状态形状风险：引擎自开轮次可以占用 ACP prompt slot，却不暴露客户端拥有的 `activeTurnId`。现有编辑后重发流程把后者当作取消门槛，因此当 provider 暴露这种组合时可能不安全。实现新增显式的 `engineTurnActive` execution 字段，在准备前、提交前和持久化后 fail closed；若已经准备 replacement，则关闭它，并在晚到标记时补偿本地 history/meta。仓库可达性复核发现，当前编辑后重发会在 provider 操作前拒绝 builtin Kimi，而已知的自主轮次 producer 是 Kimi；因此本改动是协议边界和未来 provider 兼容性的防御加固，并不能证明当前存在 Kimi 编辑后重发 P1。

## 决策

- `SessionExecutionSnapshot` 将引擎占用与客户端 ownership 分开：`hasActiveTurn` 仍是通用 ACP slot 忙碌信号，`activeTurnId` 仍表示可取消的客户端 owner。
- 编辑后重发在初始、prepared 后、commit 前和 persist 后检查显式 engine flag。观察到引擎标记后，绝不取消引擎 owner，也不接管 replacement。
- 若本地 history/meta commit 后才检测到标记，则使用现有一次性 history rollback receipt，恢复旧 metadata 并持久化补偿，同时关闭 detached replacement。这是 fail-closed 补偿，不是事务。

## 证据与边界

- execution service 已经能产生相关的 engine-only 状态：`hasActiveTurn: true` 且没有 `activeTurnId`；新增测试使显式字段成为可观察契约。
- `SessionEditAndResendService` 当前只允许 builtin Codex 和 Claude，而仓库证据显示自主轮次标记由 Kimi ACP server 产生。review 描述的状态在接口边界上成立，但当前产品路径是否可达尚未证实。
- 进程内 rewrite barrier 会阻止本地 dispatch/steer/queue promotion，却无法阻止 provider 侧 admission。因此标记仍可能在 prepare 或 persist 期间到达，代码采用检测与补偿，而不宣称原子性。
- 补偿仍可能遇到并发文档变化；history receipt 会拒绝不安全的区间变化，metadata 恢复是最佳努力。带版本的 ACP admission lease 或 execution-level rewrite lease 属于独立的架构改动。

## 后续

- 用判别式 `SessionPromptOccupancy` 模型重审当前过载的 snapshot。
- 明确并执行 provider engine-admission 串行化，包括 transient store 只有一个 engine owner slot 的前提。
- 统一 history apply、fork/editable-tail 与 UI 对 `turnOrigin` 和 `auto:` 的判断。
- 用带 Kimi start/end 标记的 managed runtime 验证完整 live 行为。

## 验证

- CLI 聚焦套件：`session-edit-and-resend-service.test.ts` 与 `tests/session-execution-service.test.ts`，138 个通过。
- CLI TypeScript 检查仍被既有的 `acp-extension-dsh/profile` 缺失导出和 `fzstd` 缺失声明阻塞；没有出现新的 `SessionExecutionSnapshot` 错误。
- 格式检查曾要求写回一个测试文件；最终检查结果记录在任务报告中。

Spec：[session-history-writes.zh.md](../../../../specs/session-history-writes.zh.md)
