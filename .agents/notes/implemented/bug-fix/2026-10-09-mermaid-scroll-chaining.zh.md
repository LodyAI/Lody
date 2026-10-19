# 恢复 Mermaid 内嵌图上的对话滚动

Status: implemented
Translation: current

[English](2026-10-09-mermaid-scroll-chaining.md)

## 摘要

鼠标悬停在 Mermaid 内嵌图上时，对话滚动被阻断，尽管滚轮处理器没有拦截普通滚轮事件。
有高度限制的预览容器通过 CSS 阻止了边缘处的原生滚动传递，连没有垂直溢出的图表也受影响。
恢复自动滚动传递后，大图仍能内部滚动，到边缘后可以继续滚动对话。
四个独立 Chrome 回归用例覆盖短图、长图及两种激活状态。

## 决策与证据

本次修复落实已有的[内嵌视图契约](../../../../specs/mermaid-inline-view.zh.md)，
不改变激活、捏合缩放、变换保留和全屏查看器行为。
[此前的滚轮修复](2026-09-09-mermaid-diagram-gestures.zh.md)处理了事件取消；
残留问题是预览滚动容器上的 `overscroll-behavior: contain`。
将其改为 `auto`，保留高度限制和内部溢出滚动，同时允许原生滚动传递到祖先容器。
转发滚轮事件或手动滚动对话会重复浏览器已有行为，没有必要。

既有浏览器滚动测试加载实际样式表，使用与渲染器结构一致的合成图表 DOM。
测试检查上下边缘处祖先容器的滚动位置，并确认长图到达边缘前仍在内部滚动。
jsdom 的事件派发不能检测 CSS 滚动传递，因此已有滚轮单测不足以覆盖这个问题。

## 验证与限制

四个用例使用缓存的 Playwright 和独立临时配置在无头 Chrome 中通过，
不依赖 Storybook 或外部请求。四个用例在原始样式下均失败，确认能够检测本次故障。
完整 `pnpm check` 和 `pnpm format` 因缺少工作区依赖
（`tsgo`、`oxfmt`）而中断。仓库文档检查仍有缺失 ACP 子模块导致的无关断链。
尚未执行完整应用和触屏设备验证。

- Pull request: [#1345](https://github.com/LodyAI/Lody/pull/1345)。
