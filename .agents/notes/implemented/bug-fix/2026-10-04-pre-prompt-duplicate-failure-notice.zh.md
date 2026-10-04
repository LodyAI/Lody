# 每个 prompt 前失败的 turn 只记一条失败通知

Status: implemented
Translation: current

[English](2026-10-04-pre-prompt-duplicate-failure-notice.md)

## 摘要

prompt 发出前就失败的 turn 会产生两条可见的 `chat_failed` 历史条目：
`recordPrePromptFailure` 先写一条通用的 pre-prompt 通知，随后
`handleTurnError` 又写一条分类正确的通知。JSON-RPC `-32603` 会同时出现
`turn_pre_prompt_failed` 与 `acp_internal_error`；认证错误出现两条
`acp_auth_required`；断连则是 `turn_pre_prompt_failed` 加
`agent_disconnected`。现在 `recordPrePromptFailure` 对分类器接管的错误
（`parseACPError` 命中或断连文本）直接跳过，由 `handleTurnError` 作为这些
失败的唯一写入者；非 ACP 故障仍走它的通用通知。分类、错误详情、终止与
收尾行为均不变。

## 证据

`apps/cli/src/session/session-execution-service.ts` 中
`handleVisibleTurnUnhandledError` 依次执行三步：`recordPrePromptFailure`
（对未取消且 prompt 未发出的错误追加 `chat_failed`）、`markTurnFailed`、
然后 `handleTurnError`，后者对同一错误做
`parseACPError`/`isAgentDisconnectedError` 解析并再追加一条带分类 reason 的
`chat_failed`。在 `tests/session-execution-service.test.ts` 中通过历史端口
fixture 驱动 `session/create` 失败复现：每个 ACP 形态或断连的拒绝都会在
会话可见历史里产生两条 `chat_failed`。

## 决策

归属按错误种类划分，不按先后顺序。`handleTurnError` 是其分类器能识别的
所有错误的唯一写入者，因为那条通知携带正确的 reason
（`acp_internal_error`、`acp_auth_required`、`agent_disconnected`）和
provider 原始详情文本。`recordPrePromptFailure` 只保留分类器不处理的部分：
普通非 ACP 故障仍记 `turn_pre_prompt_failed`，Git 可执行文件缺失保留
`git_executable_not_found` code。已不可达的
`instanceof AcpAuthenticationRequiredError` 分支一并移除：该错误恒带数值
`code = -32000`，会被上面的守卫交给分类器，分类器仍通过名称/代码匹配
产出 `acp_auth_required`。被否决的备选方案是"先写者胜出"去重：它会让 ACP
错误保留较弱的 `turn_pre_prompt_failed` 分类，并经由
`prePromptFailureRecorded` 门闩增加跨方法耦合。历史层泛化去重同样被否决：
它会掩盖未来出现的重复写入，而不是修正归属。

## 验证

`tests/session-execution-service.test.ts` 新增回归用例，读取用户可见的
历史状态而非 mock 调用次数：`session/create` 在 `-32603`、认证、断连、
普通错误与 Git 缺失下各产生恰好一条 `chat_failed`，reason、message、code
符合预期，且终止行为（`-32603` 与断连 force、认证 graceful）与
`setSessionError('execution_error')` 保留。prompt 已发出后的 ACP 错误仍
只记一条分类通知，创建中取消的 turn 一条不记。套件 154 个测试全绿。

未验证：本修复依赖 `handleVisibleTurnUnhandledError` 随后必然调用
`handleTurnError` 这一现有保证；未来若有不经该收尾就记录 pre-prompt 通知的
新路径，需要单独评审。
