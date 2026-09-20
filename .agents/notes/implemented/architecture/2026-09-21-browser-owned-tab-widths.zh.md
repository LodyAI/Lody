# 标签宽度交给浏览器布局

Status: implemented
Translation: current

[English](2026-09-21-browser-owned-tab-widths.md)

## 摘要

Session 标签条使用浏览器 flex 布局，随外围面板直接调整宽度，避免测量宽度后的 React
更新与额外 200ms 过渡。只有快速关闭模式捕获并固定 DOM 宽度。静止布局及多个已恢复
标签的首次渲染都没有宽度过渡。浏览器回归测试覆盖实际间距、激活项最小宽度、尺寸跟随、
鼠标关闭冻结和初次绘制；jsdom 的布局替身无法证明这些保证。

## 决策

`AdaptiveTabStripItem` 静止时使用 `flex: 1 1 0`。条目的尾部 margin 在静止与冻结
布局中统一负责间距，父元素不能再叠加 gap。viewport 是 inline-size 容器，激活项通过
`@[366px]:min-w-(--tab-active-min-width)` 在阈值以上保留 180px 最小宽度。
低于 366px 时，本分支有意均分空间，而不沿用旧分配器优先给激活项分配宽度的策略。

`captureStripGeometry` 在 pointerdown 时读取绘制宽度和边距。随后沿用
[快速关闭规则](../feature/2026-09-18-tab-strip-rapid-close-widths.zh.md)固定宽度，
包括让新激活项获得捕获时的激活宽度。仅此显式布局启用宽度和滑动边距过渡。
恢复 flex、初始化或恢复标签时直接应用布局。

`ResizeObserver` 更新宽度 ref，仅当 viewport 真正缩到小于捕获宽度时清除冻结。
不能每次观察都提交返回原状态的 updater：React 可能在离散关闭事件后重放提前计算为
null 的更新，覆盖渲染阶段刚建立的冻结。

## 对原验证结论的纠正

原先声称的浏览器布局一致性并未由运行中的组件证明。原 `@container-[366px]` 写法
没有生成最小宽度规则；row gap 与 item margin 重复计算间距；观察者无条件提交的更新
在真实点击后丢弃了冻结。jsdom 测试用旧分配器提供几何数据，未发现这些浏览器问题。
插桩确认 pointerdown 成功捕获了全部条目，修复无需改变事件传播方式。

## 验证

`tests/e2e/session-tab-widths.spec.ts` 在 Chromium 中测试真实 Storybook 组件。
暂停容器动画并指定动画时刻验证布局；真实点击验证连续冻结和移出后的释放；页面启动时
观察初始 DOM 几何与激活项宽度过渡。三个浏览器用例和
`tests/session-tab-bar.test.tsx` 的 23 个状态机用例均通过，组件类型检查也通过。

此前的[实时尺寸补丁](../../archived/bug-fix/2026-09-21-tab-width-live-resize.md)在 JS
分配期间抑制过渡。浏览器布局避免了逐帧测量和回写。完整打包 Electron 的启动仍不在
本次组件级验证范围内。
