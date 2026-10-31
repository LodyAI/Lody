# 会话自动继续界面移除 Beta 限制

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-session-continuation-general-availability.md)

## 摘要

Agent 已能通过 MCP 使用 Automation，但 Session 控件曾要求开发者单独启用 Beta。支持的 Session 无需该开关即可显示等待提示和设置。自动恢复仍需逐个 Session 启用；加密 Workspace 仍不受支持。

## 边界

Electron 管理本机及符合条件的远端机器 Automation owner，并在请求前检查共享 Workspace 内容能力。Agent 的 MCP 服务和 Host 继续遵循既有归属与授权规则。移除旧的纯界面偏好不会启用 Session 策略，也不需要迁移持久化的 Automation。远端控制使用[远端控制设计](../../proposed/architecture/2026-10-30-remote-session-automation-control.zh.md)；加密 Automation 仍不受支持。

组件测试覆盖普通模式下的等待、设置和取消。真实跨设备和加密交付仍未验证。
