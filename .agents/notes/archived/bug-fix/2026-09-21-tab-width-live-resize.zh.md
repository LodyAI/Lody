# 标签宽度跟随实时尺寸变化,不再缓动

Status: implemented
Archived: 2026-09-21
Translation: pending

> 已被[标签宽度交给浏览器布局](../../implemented/architecture/2026-09-21-browser-owned-tab-widths.zh.md)取代:
> 本注所打补丁的 JavaScript 分配已移除,过渡恢复为无条件启用。保留原因是关于
> container query 阈值在窄宽度下行为的推理对替代方案仍然适用。

[English](2026-09-21-tab-width-live-resize.md)

## 摘要

切换侧边栏时,桌面端 Session 标签条总是比它所在的面板慢半拍才安定下来。
`AdaptiveTabStrip` 在 JavaScript 里根据测量到的视口宽度分配整数标签宽度,而这些
宽度带着为 Chromium 增删边界动画准备的 200ms 过渡。折叠/展开会让标签条的 flex
空间逐帧变化,于是每次提交都重启一次朝该帧目标值的 200ms 缓动:标签在追一个移动
目标,而不是跟随面板。现在标签条会在由视口驱动的重新分配中抑制宽度过渡,并在下一
帧恢复,增删与关闭滑动动画保持不变。由 JavaScript 测量本身带来的延迟——标签宽度
已知之前还要等一个观察者帧——并未处理。

## 问题

布局变化会驱动标签条的 flex 空间:

- 左侧导航栏(`web-workspace-layout.tsx`)通过 `marginLeft` 滑出,在一次提交里
  就归还内容区的 flex 空间。
- Session 侧边面板(`desktop-session-detail-layout.tsx`)以 220ms 动画
  `flex-grow`/`min-width`,聊天列因此逐帧移动。

`AdaptiveTabStrip` 用 `observeResizeOnAnimationFrame` 测量该列,把宽度存入
state,再通过 `allocateAdaptiveTabStripLayout`
(`adaptive-tab-strip.tsx:305`)重新分配每个条目的 `width`。此前每个条目元素都带着
`transition-[width,margin-inline-start] duration-200`
(`adaptive-tab-strip.tsx:648`)。该时长是为移除/插入准备的 `BoundsAnimator` 复刻
(见[快速关闭宽度](../../implemented/feature/2026-09-18-tab-strip-rapid-close-widths.zh.md)),
但它同样作用于视口驱动这条路径,而这条路径的目标值每帧都在移动。结果是一阶滞后:
面板停下后标签还要缓动收尾,读起来就是"标签慢半拍"。

## 决策

`AdaptiveTabStrip` 通过 context 暴露 `transitionEnabled`,为 false 时条目不再带
过渡 class。它仅当 `viewportWidth === settledViewportWidth` 时为 true。

`settledViewportWidth` 是独立的 state,比测量宽度晚一次绘制,由 effect 在下一个
动画帧恢复。有两点使其成为必要:

- 移除逻辑已在用的"渲染期派生状态调整"会在提交前重跑组件。因此,若调整块也设置这
  个标记,它描述的是被 React 丢弃的那次渲染——判断必须读取上一次提交的宽度,而这
  正是 `settledViewportWidth`。
- layout effect 在绘制前刷新,在那里恢复会把过渡重新加到承载新宽度的那次样式重算
  上,尺寸变化仍然会缓动。恢复因此延后一帧。

调整块中标签 id 改为按**值**比较(`itemIds.join('\u0000')`)。父组件重渲染(侧边
栏切换本身就会触发)会把 `itemIds` 重建为内容相同的数组,原先的引用比较会把每次
尺寸变化都判成标签变更,恰好在错误的场景下抑制了过渡。

只有视口驱动的重新分配会抑制动画。带有新条目或新选中项的提交仍然会动画:它经由正常
渲染路径进入 `transitionEnabled` state,而恢复只在 `viewportWidth` 变化之后发生。

## 考虑过的替代方案

直接由待处理的 `renderedViewportWidth !== viewportWidth` 比较推导该标记:试过,不行
——调整块在被丢弃的那次渲染里就消费了该值,于是提交的渲染读到两侧相等、过渡仍开着,
尺寸变化照样缓动。渲染期写 ref 同样失败,因为 React 会重放组件,提交渲染运行时该
ref 已不再标记首次测量。

仿照快速关闭模式,把过渡抑制到指针离开标签条:已否决。尺寸变化没有可依据的指针手势;
它随面板停止而结束。

保留过渡但缩短时长:作为猜测否决。任何非零时长都会重现逐帧重启,零就是本方案。

从根上修掉 JavaScript 分配本身(改用纯 flex 布局,让浏览器在与面板同一次样式重算中
定尺寸)仍是更根本的答案。它会改变 `activeMinWidth` 的分配语义并牵涉大量精确像素
断言,因此留作独立工作。

## 验证

`packages/components/tests/session-tab-bar.test.tsx` 新增回归用例:拉宽模拟视口并
观察条目元素——写入新宽度的那次提交不带过渡 class,下一帧恢复,静止态保留该 class
供下一次增删使用。该用例在原先无条件携带 class 的版本上失败。既有快速关闭套件
(关闭冻结、滑动边距、插入长入、替换形变)全部原样通过,`adaptive-tab-strip` 的分配
器测试同样通过:所属三个文件 39/39,`@lody/components` 全套 3763/3763,
`tsgo --noEmit` 无诊断。

尚未在运行的桌面构建中实测;实时拖拽面板时的逐帧行为由测试覆盖的状态迁移推断。由
JavaScript 测量路径带来的一帧延迟仍然存在。
