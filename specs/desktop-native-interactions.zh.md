# 桌面原生交互

Status: draft
Translation: current

[English](desktop-native-interactions.md)

## 场景与行为

桌面用户选择本地项目时，目录选择器从用户主目录开始。显式设置起点，避免
Electron 默认行为变化，同时允许用户自由导航到其他目录。

应用发送原生会话完成通知时，IPC 仅在 Electron 发出 `show` 事件后报告成功。
若 Electron 发出 `failed`，结果包含失败原因。同步初始化失败通过同一结果契约报告。

终端文本和图片剪贴板写入必须完成后，IPC 才能报告成功。无效图片不改变剪贴板；
原生写入被拒绝时返回可恢复的失败。Electron 44 运行时与异步图片剪贴板实现一起交付。

Electron 44 桌面要求 macOS 13 或更高版本。macOS 12 不在此运行时支持的系统范围内。

## 证据

- [原生通知投递](../apps/electron/src/main/services/notification-delivery.ts)
- [本地项目选择](../apps/electron/src/main/ipc/services/local-projects-ipc.ts)
- [终端剪贴板 IPC](../apps/electron/src/main/ipc/services/terminal-ipc.ts)
- [图片剪贴板服务](../apps/electron/src/main/services/image-export-service.ts)
