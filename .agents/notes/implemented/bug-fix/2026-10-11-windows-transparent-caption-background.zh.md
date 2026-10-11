# Windows 原生窗口按钮背景透明化

Status: implemented
Translation: current

[English](2026-10-11-windows-transparent-caption-background.md)

PR: [#1437](https://github.com/LodyAI/Lody/pull/1437)

## 摘要

Modal 或 Dialog 遮罩使页面变暗时，Windows 原生窗口控制按钮仍保留不透明的主题背景，右上角因此出现明显色块。深浅主题现均使用 Electron 透明 Window Controls Overlay 背景，让原生按钮下方能够显示页面遮罩。36px 高度、按主题选择的图标颜色和原生按钮行为保持不变。配置和主题切换已通过单元测试，Windows 真机视觉效果仍待验证。

## 决策与职责

`window-theme.ts` 为两个主题提供 `color: '#00000000'`。`window.ts` 在创建窗口时使用该 helper；`app-ipc.ts` 已通过 `applyResolvedWindowTheme` 在显式及系统主题更新时复用它。窗口自身的背景仍不透明。无需 Modal 状态 IPC、自绘窗口按钮或 Native Addon。

本次调整了此前[窗口按钮对齐决策](2026-09-23-windows-caption-centerline.zh.md)中的按钮背景，保留其几何布局。当前实现说明见[会话窗口顶部栏](../../../docs/sessions-tabs-routing.md)。

## 证据与限制

当前检出版本固定的是 Electron 43.7.6，而非问题背景中的 44.7.0。该版本的 [`WinCaptionButtonContainer::UpdateBackground`](https://github.com/electron/electron/blob/v43.7.6/shell/browser/ui/views/win_caption_button_container.cc#L139) 已在 overlay 背景 alpha 小于 255 时将图层标记为非不透明，因此无需升级依赖。另见 Electron [PR #38693](https://github.com/electron/electron/pull/38693)。

现有 `window-theme.test.mjs` 的四个用例全部通过。主题用例现以明确的颜色和高度断言窗口最终外观，覆盖浅色 → 深色 → 浅色以及 macOS 平台限制，替代使用同一个 helper 比较调用记录的断言。`pnpm check` 因缺少 `tsgo`/`tsc` 停止；该工作区未安装依赖，Oxfmt 同样不可用。原生绘制、悬停、最大化/还原以及两种主题下的 Modal/Dialog 外观仍需 Windows 冒烟验证。
