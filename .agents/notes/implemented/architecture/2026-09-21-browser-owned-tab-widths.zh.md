# 标签宽度交给浏览器布局

Status: implemented
Translation: current

[English](2026-09-21-browser-owned-tab-widths.md)

## 摘要

桌面端 Session 标签条原本在 JavaScript 里根据测量到的视口宽度分配整数标签宽度,
再以 inline style 写回。于是每次尺寸变化都要等一圈 `ResizeObserver` 和一次 React
提交,而且每个标签 200ms 的宽度过渡会去追一个移动目标——切换侧边栏时,标签总是比
它所在的面板慢半拍才安定。现在这一行改为纯 flex(`flex: 1 1 0`),由浏览器在与面板
同一次样式重算里定尺寸;激活标签的 180px 最小值由标签条上的 container query 保底。
侧边栏与窗口缩放不再需要测量,也不再逐帧写宽度。代价是激活标签在中段的"硬顶"消失
了:低于查询阈值时各标签均分,而不是把激活项钉住、让同伴塌到零。

## 问题

`AdaptiveTabStrip` 保存测量到的 `viewportWidth`,通过
`allocateAdaptiveTabStripLayout` 推导每个条目的 `width`,并以 inline style 加上
200ms 的 `transition-[width]` 应用。切换侧边栏会改变标签条的 flex 空间(左侧导航栏
在一次提交里归还空间;Session 侧边面板以 220ms 动画 `flex-grow`),而每个观察到的帧
都会重启一次朝该帧目标值的缓动。这个滞后是结构性的:DOM 宽度只能在观察者回调加一次
React 提交之后才可能变化。

## 决策

`AdaptiveTabStrip` 不再测量、也不再写静止态宽度:

- 标签条是 flex 行(`gap`、padding),每个条目为 `flex: 1 1 0` 且 `min-width: 0`。
  浏览器在解析其外围面板的同一次样式重算里解析这些宽度,不涉及观察者,也不涉及
  state。
- 激活标签通过 `@container-[366px]:min-w-(--tab-active-min-width)` 保持
  `ACTIVE_TAB_MIN_WIDTH`,长度以自定义属性挂在该条目上。标签条的 viewport 是容器
  (`container-type: inline-size`);366px 阈值略高于两倍最小值,也就是保底不再挤压
  其余标签的位置——它是经实测验证的常量而非计算值,因为 Tailwind 需要源码里出现完整
  的 class 字面量。
- `ResizeObserver` 仅保留一项职责:当标签条缩到小于本次手势捕获的宽度时,释放冻结
  布局。它只写一个 ref,不触碰其他 state。

关闭模式的冻结行为不变,但几何改从 DOM 读取。`captureStripGeometry` 在
`pointerdown`(关闭手势唯一可能的起点)快照每个条目的绘制宽度、滑动边距与标签条的
padding,使冻结与滑动边距有数值可用,而无需逐帧跟踪视口。冻结条目是标签条唯一仍写
显式宽度的地方。条目自身的右边距并不是 gap(gap 在父元素的 `gap` 上),因此捕获时
该项回退到配置的 gap。

200ms 宽度过渡恢复为无条件启用:浏览器掌握静止态宽度后,它只会因冻结释放、插入或
移除而触发。为此服务的 `transitionEnabled` context 及其视口滞后 state 已删除。

## 考虑过的替代方案

不加 container query、只用固定 `min-width`:在窄标签条里会溢出(实测 120px 容器里
排出 214px),而不是收缩,所以那条查询正是让单个 `min-width` 安全的前提。

让每个条目自成容器(条目上 `container-type: inline-size`,查询
`@container (min-width: 180px)`):已否决。此时查询量的是条目自身的盒子,而在
`flex: 1 1 0` 下激活标签在中段永远够不到 180px,恰是该保底的时候。

由行宽代数推导阈值(`2M + (g(n−1) + 2P)/n`):试过后因误判边界而否决。在有效标签数
区间内,大致 [365, 375] px 之间的任何取值行为完全相同,因此该常量由下文的引擎比对
验证,而非由公式计算。

## 取代的决策

- [实时尺寸下的标签宽度](../../archived/bug-fix/2026-09-21-tab-width-live-resize.md)为了在
  JavaScript 分配上打补丁而抑制视口驱动重分配的过渡;本注移除该分配,其行为已并入
  此处。
- [快速关闭时的宽度冻结](../feature/2026-09-18-tab-strip-rapid-close-widths.zh.md)
  仍拥有冻结语义。其 `AdaptiveTabStrip` 布局内部实现已被取代;冻结本身除改为读取
  DOM 快照外没有变化。

## 验证

在 Chromium 152 上,对 190px~2400px 的每个宽度与标签数,与
`allocateAdaptiveTabStripLayout` 逐项比对:唯一差异是分配器 `Math.floor` 余数带来
的 ±1px(flex 会把余数均分),两种方式下激活标签都钉在 180px。低于阈值时旧分配器
即使预算不足也会钉住激活项——200px 两个标签时得出 178/0——而 flex 均分,这是唯一
一处有意为之的行为变化。

`packages/components/tests/session-tab-bar.test.tsx`(23 个用例)按新模型重写:
jsdom 里用一个替身把 flex 结果供给 `getBoundingClientRect`,从而覆盖冻结、滑动
边距、冻结重铺与视口缩小时的释放;静止态则断言不携带 inline 宽度、且激活项带保底。
`@lody/components` 全套 3762 个用例通过,`tsgo --noEmit` 无诊断。尚未在运行的桌面
构建中实测;container query 本身是 CSS,由上文的引擎比对而非 jsdom 覆盖。
