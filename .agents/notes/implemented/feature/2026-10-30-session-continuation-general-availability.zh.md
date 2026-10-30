# 会话自动继续界面移除 Beta 限制

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-session-continuation-general-availability.md)

## 摘要

Agent 已能通过 MCP 使用 Automation，但 Session 控件仍要求开发者单独启用 Beta。支持的本机 Session 现在无需该界面开关即可显示已有的等待提示和设置。自动恢复仍需逐个 Session 启用，远端界面和加密 Workspace 也不会因此获得控制通道。

## 边界

Electron 只读取和管理当前机器上的 Automation owner，并在请求前检查共享 Workspace 内容能力。Agent 的 MCP 服务和 Host 继续遵循既有归属与授权规则。移除旧的纯界面偏好不会启用 Session 策略，也不需要迁移持久化的 Automation。远端 Agent 可使用其机器上的 MCP 和 daemon；跨设备 UI 控制及加密 Automation 需要单独完成传输和授权工作。

组件测试覆盖普通模式下的等待、设置和取消，以及没有支持的本机目标时不请求 owner。CLI 和组件类型检查及相关测试结果随本次修改报告；跨设备和加密交付仍未测试且不受支持。
