# 移动工作区底部导航的连续动画

Status: implemented
Translation: current

[English](2026-10-05-mobile-workspace-dock-motion.md)

## 摘要

导航外壳与子元素的布局动画叠加，拉伸了选中图标。已接受的原型 D 保持带键标签挂载，用一个弹簧驱动实际几何和淡化。向下滚动收起，向上滚动展开。代价是布局与绘制工作，Android 真机性能仍未验证。

## 决策

选中图标保持不透明且为 24×24；拒绝复制图标和整个面板交叉淡化的原型 B/C。[组件](../../../../packages/components/src/components/mobile/mobile-workspace-tabbar.tsx)采用可重新设定目标的单一弹簧（刚度 420、阻尼 40、质量 1、静止阈值 0.001）、派生 MotionValue、稳定宽度观察槽以及可选操作的固定 56px 槽。不使用布局投影或共享标识；旧 `layoutId` 参数保留但不使用。

DOM 与命令式滚动共用方向累计；切换来源重置基准，有效的命令式信号优先。在应用 inert 前转移焦点，否则 Chromium 可能清除焦点。显式设置 `transition-property: none`，避免全局减少动态效果 CSS 对弹簧跳转再次插值。[Spec 草案](../../../../specs/mobile-workspace-dock.zh.md)负责行为约定。

交互参考 Apple 的[滚动收起标签栏](https://developer.apple.com/videos/play/wwdc2025/284/?time=151)与[可中断弹簧](https://developer.apple.com/videos/play/wwdc2023/10158/)，实现采用 Web 几何变化，不是原生 Liquid Glass。跟踪：[#1257](https://github.com/LodyAI/Lody/issues/1257) · [PR #1258](https://github.com/LodyAI/Lody/pull/1258)。

## 证据与边界

受控时钟浏览器测试在中途反向时采样 SVG 身份、边界、透明度与可见范围，并覆盖焦点、方向阈值、减少动态效果、尺寸变化及缺少选择／FAB。三个代表性几何用例覆盖两种主题、两条滚动路径和首／中／末标签，不再使用笛卡尔组合。组件测试保留来源切换和标签变化；删除的 jsdom 实例测试无法检测布局投影。原组件在几何回归测试中测得图标宽度 80.25px，而非 24px。

探索性 Chromium 145 无头 Storybook 性能采样（393×852、DPR 1、正常／4 倍 CPU 限速；空闲、反向、连续滚动各采样 240 帧）未观察到 50ms 以上长任务。回调间隔 p95 为 9.4–10.3ms，不等于实际呈现帧率。4 倍限速下，layout／paint 事件 p95 最大值为 0.79／0.671ms。连续信号输入产生 343–351 次 React 根提交，DOM 滚动为 6 次，包含 story 状态；真机如仍有开销，应调查此路径。

Android 真机／WebView、GPU 合成与生产构建性能未验证。全量检查遇到 ACP SDK 和 viewer／Electron 依赖缺失；文档检查遇到指向缺失 ACP 子模块的断链。这些环境失败不能证明全局正确性。
