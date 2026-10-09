# DeepSeek Harness Core 能力

Status: draft
Translation: current

[English](deepseek-harness-core-capabilities.md)

## 执行归属与历史

DeepSeek Harness 客户端可以在不激活会话的情况下浏览历史、引导正在运行的回合、管理目标，并观察子代理和后台任务。所有模型执行必须归属于客户端持有的 prompt；能力声明只能描述当前组合实际可用的接口。

历史发现使用标准 session/list。Core sessionHistory 通过只读快照回放根会话，不执行 resume、修复写入或模型调用。Lody 优先使用声明的只读接口；内置 DeepSeek 缺少此契约时明确失败。load/resume 保留独立的[恢复行为](deepseek-harness-session-restore.zh.md)。

Steering 仅适用于当前原生回合及其现有配置；消息被持久化消费后才发出应用通知。空闲、取消或被拒绝的输入不能意外启动后续回合。

Goal 的 set/resume 通过 session/prompt 的 Core goalControl 传入；该 prompt 跨原生自动续轮保持打开。pause/clear 可在运行中通过独立请求访问。取消暂停续轮。原生轮数上限映射为 limited，不伪造 token 预算。原生 active 但已解除续轮授权的目标不能报告为正在继续执行。后台任务完成可以更新状态，但不能独立唤醒空闲根 Agent；模型通知等待后续有归属的 prompt。

子代理请求使用执行 ID 并检查根会话归属。列表覆盖本次激活观察到的执行；本地执行支持取消，远端仅提供其原生发布的输出与生命周期。会话驻留不等于执行中。重试活动在重试启动或回合结束时终结；当前上下文使用量与累计 token 记账独立。

## Worktree 身份与限制

worktreeProject 指向可解析的原项目绝对目录，跨运行时重启保留，fork 默认继承且可显式覆盖。按原项目列历史时包含关联 worktree 会话。实际 cwd、沙箱、MCP 与 worktree 生命周期不变。关联存储属于适配器，原生会话存储仍由 Harness 管理。

当前 API-key 组合没有账户额度窗口数据源，因此不声明 rateLimits。实验性定时唤醒没有 ACP 执行归属传输，因此不声明 tasks.scheduled。这些缺口必须明确保留，不能用空成功响应或虚假能力声明掩盖。

## 证据

- [适配器契约与原生验证](../packages/acp-extension-dsh/README.md#core-controls)。
- [实现决策](../.agents/notes/implemented/feature/2026-10-09-dsh-core-capabilities.zh.md)。
