# 开发者控件可以重新开始引导

Status: implemented
Translation: current

[English](2026-10-14-developer-restart-onboarding.md)

## 摘要

桌面端引导的完成标记由 Electron 主进程保存，可恢复的阶段和草稿则保存在 renderer 中，因此只修改其中一个存储无法可靠地重新开始流程。现在 About 的开发者模式中提供了重新开始操作：清除 renderer 进度和本轮 session flow ID、重置主进程的完成标记、恢复原生浅色主题，并让主窗口重新加载到 `/onboarding`。该操作仅接受主窗口可信 IPC 调用，且不会清除已配置的 Agent、项目或工作区。本次没有运行自动行为检查。

## 决定

现有引导约定由 Electron 主进程保存持久完成标记，并由 renderer 保存可恢复进度。新操作遵循这一职责划分：renderer 清除 `desktopOnboardingPhaseAtom`、`desktopOnboardingDraftAtom` 和 session 级 analytics flow ID，随后专用 IPC 方法验证主窗口主 frame 的发送方、重置持久完成标记、将原生窗口主题设为浅色、把 renderer 重载目标改为 onboarding，再执行重载。

这个按钮放在桌面 About 的开发者模式控件中，作为本地开发便利功能。它不会清除 Agent 配置、项目或工作区等产品设置；这些内容在再次体验引导时仍然有用。重载目标使用标准产品 renderer，即使启用了 Devbar renderer 也能打开引导流程。

## 验证边界

没有运行测试或应用检查。实现复用现有路由、状态 atom 和重载机制；仍需手动启动桌面应用，确认完整界面流程。
