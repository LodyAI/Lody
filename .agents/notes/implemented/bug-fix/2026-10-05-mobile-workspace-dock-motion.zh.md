# 移动工作区底部导航的连续动画

Status: implemented
Translation: current

[English](2026-10-05-mobile-workspace-dock-motion.md)

## 摘要

父子布局动画叠加导致选中图标拉伸。已接受的原型 D 保持图标身份，用一个可重新设定目标的弹簧驱动实际几何。代价是布局与绘制工作；Android 真机性能仍未验证。

## 决策

复制图标和整个面板交叉淡化均未达到所需的连续性。保持标签挂载，测量稳定宽度槽；可选操作预留固定空间，避免其动画反过来影响导航宽度。行为见 [Spec](../../../../specs/mobile-workspace-dock.zh.md)。

两个浏览器细节需要保留：应用 inert 前转移焦点，否则焦点可能被清除；动画驱动的元素禁用 CSS 过渡，否则全局减少动态效果 CSS 会对弹簧跳转再次插值。

## 证据与边界

探索性浏览器检查发现原本 24px 的图标宽度达到 80.25px，并验证修复后中途反向仍保持固定几何。这些检查未作为回归测试保留。正常／4 倍 CPU 限速的无头 Storybook 采样未观察到 50ms 以上长任务，但连续命令式信号比 DOM 滚动产生更多 React 工作。生产 Android／WebView 与 GPU 合成仍未验证。

[#1257](https://github.com/LodyAI/Lody/issues/1257) · [PR #1258](https://github.com/LodyAI/Lody/pull/1258)
