# iOS 折叠切换时读取文档宽度

Status: implemented
Translation: current

[English](2026-10-27-ios-fold-layout-width.md)

## 摘要

Duo 键盘打开时折叠切换，WebKit 的 `innerWidth` 可能仍是旧屏幕宽度，即使文档
已经调整大小，导致宽屏仍显示手机布局。原生 iOS 现在读取并监听文档视口宽度；
其他平台保持原有行为。真实设备切换仍需模拟器和实机验证。

## 决策与证据

原生模拟器中，文档宽度已更新而 `innerWidth` 仍属于先前屏幕；仅监听 resize
可能采到旧值。原生 iOS 观察文档并读取其 `clientWidth`，尚无文档尺寸时回退到
`innerWidth`。行为测试模拟窗口宽度延迟。这与[原生侧边栏](../feature/2026-10-27-native-side-rail.zh.md)是独立决策。
