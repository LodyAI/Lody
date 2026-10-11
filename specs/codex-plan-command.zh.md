# Codex 规划命令

Status: draft
Translation: current

[English](codex-plan-command.md)

用户发送 `/plan <需求>` 时，Lody 开启 Codex 规划模式并在该模式下提交需求。已开启的规划模式保持开启。正文、后续内容块和附件均保留，命令前缀不进入模型输入。单独 `/plan` 保持切换模式的原有行为，不启动模型轮次。

Codex 适配器负责命令解析和模式设置，并声明可选的正文参数。配置成功后才提交内容，不改变审批或沙箱设置。带内容的请求在两个 ACP 版本中都遵循正常的接收确认、取消和失败流程；ACP v2 不得按本地命令提前确认。

## 证据

- [命令处理](../packages/acp-extension-codex/src/CodexCommands.ts)
- [配置测试](../packages/acp-extension-codex/src/__tests__/CodexACPAgent/session-config-options.test.ts)
- [ACP v2 生命周期测试](../packages/acp-extension-codex/src/__tests__/CodexACPAgent/prompt-v2.test.ts)
