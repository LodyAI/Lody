# 在无动画时隐藏正在退场的引导文案

Status: implemented
Translation: current

[English](2026-09-09-onboarding-reduced-motion-copy.md)

## 摘要

Reduced motion 会禁用引导序列的退场动画，使上一段标题与描述在最后一拍上仍然可见。正在退场的
文案现在拥有显式的零不透明度静止状态。常规 CSS 动画会在交叉淡入淡出期间覆盖该状态，因此既有
时序保持不变。这修复了 [issue 207](https://github.com/LodyAI/Lody/issues/207) 报告的渲染
缺陷，且不改动仪式流程的生命周期。

## 决策

`intro-sequence.tsx` 同时拥有退场动画与 reduced-motion 覆盖。为退出层附加专用 class，并把它
的静止不透明度声明在 keyframes 旁边。`aria-hidden` 与进入层保持不变。

Issue 中曾考虑把动画时长设为接近零，但当动画完全不运行时，显式的静止状态同样有效。本次不新增
定时器、animation-end 清理、依赖或状态迁移。独立的 stage-departure 变换仍不在该 issue 范围内。

## 证据与限制

Chromium 在基线 `158030ea` 加上本修复的代码上渲染了真实组件与插图，使用隔离的 Vite 测试载体，
桩掉宿主工具并沿用既有本地依赖。Playwright 在每一拍控制时钟。在 1180 x 620 与 390 x 844 下，
reduced 与常规 motion 中三段过渡都得到退出层不透明度为 0、进入层为 1 的结果。常规动画在 0、
160 与 320 毫秒的采样保留了交叉淡入淡出。跳过引导与 setup 回调同样通过。

仅移除新增的 CSS 声明即可复现退出层不透明度为 1 与文案重叠。修复前后的截图经过人工目视检查。
这是仅渲染层的验证，不是打包后的 Electron 测试。

改动的 TSX 通过 Prettier 与 Oxlint。完整的 `pnpm check` 与 `pnpm format` 曾尝试运行但被中止，
因为该隔离 worktree 缺少完整的工作区依赖与已初始化的 adapter submodule。本记录不宣称完整测试
套件通过；浏览器测试载体是本地验证，而非新提交的回归套件。
