# 保持 Windows 设置导航的可用宽度

Status: implemented
Translation: current

PR: [#1499](https://github.com/LodyAI/Lody/pull/1499)

[English](2026-10-12-settings-navigation-scrollbar.md)

## 摘要

桌面设置的导航使用原生滚动条，内容区使用悬浮滚动条。在 Windows 上，原生滚动条会占用 48px 图标导航栏的部分宽度，导致类别溢出时按钮变窄、图标偏移。导航现在复用现有 ScrollArea，内容溢出时显示滑块。类别树和键盘导航保持原有实现；打包后的 Electron 和实际显示器缩放需要单独验证。

## 决定

[窄面板改进](2026-10-01-narrow-settings-panel.zh.md)让导航缩成图标栏时保持挂载，但原生滚动容器仍会预留由系统决定的滚动条宽度。仅把原生滚动条变细仍会保留这项布局依赖。

[`desktop-settings-modal.tsx`](../../../../packages/components/src/components/settings/desktop-settings-modal.tsx)现在复用内容区的 ScrollArea 组件。导航 viewport ref 负责选中项滚动和尺寸观察，其父元素为保留导航宽度的滚动区域根节点。内边距和类别间距放在内部内容容器，反馈按钮继续固定在滚动区域外。滚动条覆盖在边缘，仅在内容溢出时出现。

强制颜色模式下，滑块使用向内的 1px CanvasText 轮廓，在系统浅色、深色背景以及悬停和拖动时保持可见，并保留系统颜色自动调整。最初的 StyleX 背景色覆盖无效，因为组件的 Tailwind 背景样式位于更靠后的层叠层；轮廓样式避开这项冲突，无需改变全局样式。

全局滚动条规则、平台检测、字号偏好、类别顺序及窗口标题栏保持现有实现。Windows 标题栏透明背景已在 [PR #1437](https://github.com/LodyAI/Lody/pull/1437) 中完成。

## 验证

Windows Chromium 145 的 500 × 360 窗口实测显示，原有 48px 导航栏只有 33px 可用宽度，按钮宽 21px，图标向左偏移 7.5px。替换后可用宽度为 48px，按钮恢复为 36px，图标居中。无头浏览器验证需要移除 Playwright 默认的 `--hide-scrollbars` 参数，才能暴露原生滚动条挤占宽度的问题。

现有[浏览器测试](../../../../packages/components/tests/e2e/desktop-settings-layout.spec.ts)使用合成 Storybook 数据检查导航布局、滚动、选中项、缩放状态保持和嵌套编辑窗口。新增回归覆盖检查溢出时不占用可用宽度、真实滚轮和滑块拖动，以及强制颜色模式浅色和深色背景下的滑块对比度。原有键盘断言跟随角色和 MCP 之间新增的记忆类别更新，编辑器测试在团队标签页验证分享开关。具体检查结果和环境限制记录在 PR 中。跟踪问题：[#1498](https://github.com/LodyAI/Lody/issues/1498)。
