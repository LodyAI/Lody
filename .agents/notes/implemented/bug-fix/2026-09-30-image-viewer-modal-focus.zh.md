# 让共享图片查看器成为键盘模态窗口

Status: implemented
Translation: current
PR: [#1177](https://github.com/LodyAI/Lody/pull/1177)

[English](2026-09-30-image-viewer-modal-focus.md)

## 摘要

共享图片灯箱的 Tab 会进入背景附件，关闭和前后翻页控件则是 SVG 或 div。
修复保留 PhotoSlider 的缩放、平移、背景关闭和图库引擎，将其 portal 纳入模态焦点边界，
并提供有名称的 UI 按钮。打开时聚焦关闭按钮，焦点在查看器内循环，关闭后回到仍连接的打开按钮；
背景在打开期间为 inert。桌面与手机尺寸 Chromium 回归通过；生产环境、原生触摸与辅助技术仍需独立验收。

## 决定与证据

`react-photo-view` 有 window 级方向键/Escape 处理，却没有模态焦点隔离，默认控件也不是原生按钮。
仅改变角色无法防止背景焦点泄漏。替换图片引擎则会影响已有
[手势决策](2026-09-27-mermaid-and-image-viewer-gestures.zh.md)。

使用已有 Floating UI 依赖提供焦点守卫、恢复与背景 inert。
PhotoSlider 在模态边界内部创建 portal，保留适配 Vaul 的外层容器和 no-drag 标记。
关闭库的默认 banner，由透明的 `@lody/ui` ghost 按钮提供翻译后的可访问名称。
控件采用深色调色板，以在原有遮罩上保持对比度，不增加按钮常驻底色，也不改变遮罩颜色或透明度。
方向键/Escape 在模态内部仅处理一次，不再同时触发库的 window 监听器。
保留图库端点限制，以及超过三张图片时的循环行为；全尺寸图片加载前仍可操作。

## 验证与边界

新增行为单测在原组件失败，修复后通过。现有图片预览测试集共 11 项通过，
包括图片加载前状态、复制/保存字节和点击照片不得关闭。Chromium E2E 在 1280px、390px 均通过：
初始焦点、原生 Tab/Shift+Tab 循环、背景 inert、Right 翻页、点击上一张、
Enter 激活下一张、Escape、按钮关闭及打开按钮焦点恢复。
独立浏览器人工交互也确认单一命名 dialog、焦点循环与恢复；已目视检查合成图库截图。
共享组件类型检查通过。

未进行登录态生产验收或部署。原生 Vaul 触摸手势、Electron 窗口控件及读屏播报未人工复验。
已移除或禁用的打开按钮无法聚焦；调用方仍须保留连接且可聚焦的打开入口。
