# iPhone Duo 视口适配

状态：已实现

[English](2026-10-27-iphone-duo.md)

## 实现

- 原生 WebView 容器分别应用当前窗口的左右安全区。
- 通过 `UIKeyboardLayoutGuide` 将停靠键盘的遮挡高度传给共享界面。
- 将 UIKit 的横向和纵向屏幕分区坐标传给共享界面。
- 系统提供竖栏、侧边避开保留区域后仍有足够空间时，原生侧栏显示导航和聊天操作。
- 新增无需账号的[原生视口测试页](../tests/fixtures/viewport.html)。

共享界面适配见 [PR #2005](https://github.com/LodyAI/Lody/pull/2005)。

## 构建

完整屏幕适配使用 Xcode/iOS SDK 27.1 或更新版本，部署目标为 iOS/iPadOS 16.4。
Duo 构建命令见 [BUILDING.md](../BUILDING.md#iphone-duo)，iOS 发布工具链更新见
[PR #3888](https://github.com/loro-dev/lody/pull/3888)。
