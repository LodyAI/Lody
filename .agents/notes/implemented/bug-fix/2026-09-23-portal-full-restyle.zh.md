# 弹层导致整个应用重算样式

Status: implemented
Translation: current

[English](2026-09-23-portal-full-restyle.md)

## 摘要

在大工作区里切换会话、悬停侧边栏时明显卡顿。生产构建的 Chrome trace 显示，每次弹层挂载时 Radix
`Presence` 都会强制重算整个文档的样式（约 12,350 个元素，约 30ms）。原因是 Konsta UI 的
`last-child-hairline-b-none` 工具类：它的 `:last-child … ::after` 选择器最右侧没有锚点，导致
`<body>` 最后一个子元素的任何变化都会重算整个 `#root`；而 Konsta 的源码被 Tailwind 扫描进了全局
样式，尽管没有渲染任何 Konsta 组件。现已移除该扫描，另加一个常驻哨兵元素让 `#root` 永远不是
`<body>` 的最后一个子元素作为第二道防线，并去掉了两处较小的切换开销。在真实页面中弹层插入从约
25ms 降到 0.3ms；CSS 修改后的端到端 trace 尚未录制。

## 证据

- trace 通过 CDP 从未压缩的生产构建（`vite build --mode dev`，连 staging）录制，不经过 DevTools
  前端（它在这个页面上会崩溃）。第一份 trace 中，切换会话期间 3.6s JS 里有 1.1s 是
  `getAnimationName`；73 次强制 `UpdateLayoutTree`，每次约 15–35ms、约 12,350 个元素。
- 页内计数器把这些读取归因到侧边栏会话悬浮卡片（向右弹出的 `Popover`）。DOM 变更日志显示卡片会向
  `<body>` 追加 popper 容器和 Radix focus guard。在 `<body>` 末尾追加任意节点耗时 23–38ms；插到开头
  为 0；插进 `#root` 之后的常驻兄弟元素也为 0。
- 在线上页面删除 CSS 规则无法证明什么：Blink 一旦设置"子元素受位置规则影响"的标记就不会清除。
  因此把真实 DOM 和全部 7,302 条展开后的规则克隆进全新 iframe 二分。全部规则 22–24ms；去掉
  `last-child-hairline-b-none` 后 0.2ms。以 class 锚定的改写（`> :last-child .hairline-b::after`）
  0.3ms，而仅保留"直接子元素"部分（`> :last-child::after`）仍是 25.7ms。只含普通 `:last-child`、
  `:not(:last-child)`、`~`、`:has()` 或 `space-y` 规则的合成页面无法复现。
- 移除扫描后，即使故意去掉哨兵、让 `#root` 重新成为最后一个子元素，真实页面中追加节点也只要 0.3ms。

## 决策

- `src/tailwind/index.css` 不再 `@source` 扫描 `konsta/react`、`konsta/shared`、`konsta/styles`。
  实际只用到主题、safe-area 工具类和 `safe-areas` 钩子；减少了 417 个类（69KB），所有被标记为
  "仍被引用"的类都是误报，其真实的变体写法仍由我们自己的源码生成。
- `lib/body-tail-sentinel.ts` 由 `routes/__root.tsx` 调用一次，在 `#root` 之后插入隐藏元素，使将来
  任何第三方 CSS 的位置选择器都无法让弹层增删重算整个应用。Web、桌面和移动端都经过这个根组件渲染。
- 会话悬浮卡片在其所在行被按下后保持关闭，直到指针移动超过 4px：导航会在静止的指针下重新渲染行，
  重新触发 `pointerenter`，从而在切换的同一次提交里打开卡片。
- `ChatComposer` 不再在 layout effect 里用 `getBoundingClientRect` 测量自身；那会在每次切换时强制
  对刚提交的对话做样式和布局计算（约 50ms）。其 ResizeObserver 会在绘制前提供尺寸。

未采用"把弹层渲染到专用容器"作为主修复：Radix focus guard 总是直接插在 `<body>` 上，而且每个弹层
调用点都要加 container 参数。既然已无任何引用，也无需覆写 Konsta 的工具类。

## 未决

Konsta 的 `theme.css` 仍会导入全部 Konsta 样式；目前只证实这一条工具类有影响。还没有自动检查拒绝
编译后 CSS 中未锚定的位置选择器。开发构建的 Safari 录制中看到的 doc-meta 重算在生产构建里不是主因，
本次未改动。相关滚动工作：[对话跟随模式](../architecture/2026-09-23-conversation-follow-modes.md)。
