# 保留 Codex /plan 后的请求

Status: implemented
Translation: current
PR: https://github.com/LodyAI/acp-extension-codex/pull/65

[English](2026-10-08-codex-plan-inline-prompt.md)

## 摘要

Codex 适配器拒绝 `/plan` 后的所有参数，并把所有调用归类为本地命令。修复后先开启规划模式，再把正文和附件交给已有请求流程。单独命令仍然切换模式。带内容的 ACP v2 请求等待原生消息落地，不再提前确认。

## 决策与验证

复用 `CommandHandleResult.prompt`，不增加专用的第二次模型调用。分类和分发使用相同的正文提取逻辑，包括独立文本块和只有图片的请求。模式设置失败时不提交正文。命令目录声明可选参数，审批和沙箱配置继续由原有逻辑管理。

在已有配置和 ACP v2 测试中覆盖两种初始模式、多行正文、附件、接收时机及配置失败。参见[草案契约](../../../../specs/codex-plan-command.zh.md)。类型检查和打包通过。使用合成需求完成真实 Codex 验证，只启动一个模型轮次并返回规划增量。适配器测试及针对性重跑覆盖本次改动；仓库文档检查仍被其他未初始化子模块的链接阻塞。本次源码改动不会发布或替换已安装的运行时。
