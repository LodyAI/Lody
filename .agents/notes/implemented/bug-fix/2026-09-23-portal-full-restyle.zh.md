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

## 后续削减

同一生产构建、同一工作区（9k 节点）下测得：

- **侧边栏 DOM。** 9,070 个节点中有 8,473 个来自一个 "Chats" 分组：它挂载了全部 244 行，可见的只有
  12 行。行列表现使用 `content-visibility: auto`（`sidebar-row-list`），一次全应用样式和布局计算从
  25ms 降到 10.6ms。暂不采用 JS 虚拟化：侧边栏的键盘导航、活动行滚动和分组排序都依赖已挂载的行。
  固有尺寸估计值（50px）让首次渲染过程中的滚动高度误差保持在 2% 以内。
- **GitHub 文件树。** `GitHubRepoFileProvider.searchFiles` 每次搜索都下载完整递归树（本仓库 1.7MB）。
  现由 `lib/repo-file-paths-cache.ts` 与 @ 提及搜索共用一份按分支区分的内存/IndexedDB 缓存，每个键同时
  只有一个请求。
- **PR 读取。** 每个 `useGitHubPrDetails` 实例只对自己的请求去重，信息栏和 PR 标签页会把同一 PR 请求
  两次。相同读取现在在模块级共享。
- **空闲滚动。** 原生选区的滚动处理在没有选中时也会在每次滚动读取 `Selection` 并强制同步 React 刷新，
  现在直接返回。吸底逻辑的 `scrollHeight` 读取保留：它是绘制前的修正，每次切换约 14ms，且主要是该帧
  本来就要做的布局。
- **doc-meta。** 同时完成的完整元数据读取按微任务合并为一次缓存写入，而不是每个文档一次；元数据对象
  未变的列表项保持同一引用；值比较改为遍历 JSON，而不是序列化。

- **切换渲染。** 之后的生产 trace 显示每次切换会话是一个约 100ms 的同步任务：render 约 49ms，passive
  effect 约 16ms，DOM 更新约 14ms。工作区分组的行是 memo 分组内的内联 JSX，而分组接收
  `selectedSessionId`，所以任何选中变化都会重新渲染整组的行（"Chats" 共 244 行），每行都带悬浮卡片、
  右键菜单和 Tooltip。现在行是 memo 的 `SessionGroupRow`，接收 `isSelected`，切换时只重新渲染旧、新
  选中两行。输入框自动撑高在内容为空时不再先设 `auto` 再读 `scrollHeight`，此前每次切换都会强制
  一次整页同步布局（约 5ms）。

- **启动时的元数据扫描。** 一个约 4,800 个文档（10.4 万条 meta 行）的工作区冷启动时，把整个 `['m']`
  命名空间扫了三遍：doc-meta 初始化、后台 eager-sync 的种子、启动时的 ACP 能力刷新。每遍都是一次
  550-900ms 的同步 Flock 调用，其后的缓存写入只要约 1ms。种子和能力刷新现在读取已就绪的 doc-meta
  投影（`readReadyDocMetaCache`，通过 `RuntimeDeps.readDocMetaCache` 注入），只有当前 repo 没有
  就绪投影时才扫描。投影由它自己的 watch 维持最新，因此至少和一次新扫描一样新。初始化扫描本身在
  Flock 支持分页前仍是一次阻塞调用。

- **键盘切换。** 以每秒约 6 次的速度用键盘切换时 CPU 一直很忙。通过 React DevTools 钩子统计每次提交，
  发现每次切换约有 46 次提交，其中 5 次重新渲染约 1.8 万个组件（整个布局）。原因：
  - `useLodyLiveActivity` 让顶层布局订阅了所有会话、presence 及其时钟，因此即使在该功能关闭的 Web 上，
    每约 300ms 一次跳动也会重新渲染整个应用。现在它位于叶子组件 `LodyLiveActivityHost` 中。
  - `useKeyboardNavigation` 让工作区布局订阅了侧边栏导航项；现在在按键时读取。
  - "Updated" 的全部 248 行在每次切换和每次跳动时都重新渲染：选择/归档回调依赖当前选中项，presence 跳动
    会重建实时状态 Map 和每个条目。回调改为从 ref 读取选中项，状态 Map 和条目在内容未变时沿用之前的对象
    （`lib/json-value-equal.ts`）。
  - `Notification.permission`（约 3ms，一次浏览器往返）在提示组件每次挂载时读取；最新 PR 信息按会话 meta
    缓存；关闭日志时不再读取滚动调试的几何信息。

  44 次切换的实测：主线程任务 6.6s → 4.3s，脚本 4.6s → 2.2s，阻塞时间 2.1s → 0.5s；切换这次提交渲染约
  2 千个组件，而不是约 1.8 万个。

  在同一基准上的两项后续改动（任务 4.3s → 4.0s，阻塞 0.49s → 0.24s）：
  - 对话路由关闭路由自带的滚动恢复（`shouldRouterRestoreScroll`）：它按 CSS 选择器记录所有滚动过的元素，
    并在下一次渲染后写回 `scrollTop`，成为跟随控制器所拥有视口的第二个写入方。Web 构建使用的较老
    router-core（1.159）仍会在节流的滚动监听中写 `sessionStorage`；这里使用的 1.171 只记录目标。
  - 输入区、输入框和提及输入框在每次切换时各自构建会话提及候选并重写 slug 缓存；现在共享同一结果
    （`getSessionMentionItems`）并只记录一次。slug 缓存按插入顺序保留前 200 条，很少是最近的会话；未改动。
  - Markdown 解析在 Streamdown 内部每次挂载都会重复（每次切换约 1.6ms）；缓存它需要给库打补丁，未采用。

## 未决

Konsta 的 `theme.css` 仍会导入全部 Konsta 样式；目前只证实这一条工具类有影响。还没有自动检查拒绝
编译后 CSS 中未锚定的位置选择器。doc-meta 列表已变便宜（见上），但每次缓存更新仍以 O(会话数) 推导
全部列表。侧边栏仍在 React 中渲染每一行，只是浏览器跳过了渲染工作。每次切换仍需渲染新对话（约 50ms 脚本）；相对时间的时钟 atom 跳动时仍会重新渲染所有侧边栏行；machine Flock 读取方在每次挂载时都会重新编码 version vector（约 4ms）。初始化的元数据扫描仍是一次同步 Flock 调用（这里约 700ms）；`scan` 没有
limit/游标，无法在批次之间让出主线程。`includeRaw: false` 可省约 20%。相关滚动工作：[对话跟随模式](../architecture/2026-09-23-conversation-follow-modes.md)。
