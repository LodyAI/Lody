# 跨分组与单列表虚拟化归档页列表

Status: implemented
Translation: current

[English](2026-09-18-archive-list-virtualization.md)

## 摘要

归档页会在桌面和移动 chrome 里挂载全部组头和 session 行，归档一长，打开就会卡。
现在把可见行展平（按项目时是组头加 opened-by session，单列表则没有组头），
超过文件树同款的可见行阈值后用 `@tanstack/react-virtual` 虚拟化。列表自己拥有
滚动容器，搜索/分组/排序钉在上面。jsdom 对比用同一份 200 条分组夹具分别走
静态和虚拟路径，断言虚拟路径只提交视口窗口而不是整棵树。

## 决策

一份展平行上挂一个 virtualizer，不按组各挂一个，也不用 Virtua。折叠组只贡献
组头，折叠大项目不会来回换渲染器。桌面/移动仍用原来的行组件；分组是行类型
（`header` / `session`）的差别，不是第二套列表。虚拟化后的键盘按展平下标走，
先 `scrollToIndex` 再 focus，因为 `FocusScope` 只能看到已挂载 DOM。低于阈值
时 `ArchiveListWindow` 用同一份展平行直接渲染，不挂 spacer。
`ArchivedSessionGroupSection` 只给 Storybook 用。

否决：继续让 `WebArchiveScreen` / `MobileArchiveScreen` 当滚动父级（文件树已经
踩过祖先 ref 空窗口）；按组 virtualizer（折叠、间距、跨组键盘都会碎）；Virtua
（那是聊天贴底，不是有界 session 列表）。

## 验证与限度

`archive-list-virtualization.test.ts` 固定 flatten、折叠、单列表和可见行门闩。
`archive-list-virtual-rows.test.tsx` 安装 400px 滚动口，把 4×50 分组 session
分别用无限阈值（以前的静态初始化）和生产门闩渲染，比较已提交的
`archive-session` / `archive-group` 节点和总 host 节点。虚拟窗口必须落在
视口+overscan 内，保留第一个项目组头，spacer 等于估高之和。测量为 0 的滚动口
必须不挂行。实机滑动、长按和打包客户端滚动仍在 jsdom 之外。

## 消融

删掉后套件仍通过：从文件树祖先 ref 抄来的额外 `measure()` + ResizeObserver
（这份列表自己拥有 scrollport）；`useAnimationFrameWithResizeObserver`；没用到的
`data-index` / `data-archive-virtual-row`；导出的 header/session 行别名；
`ArchiveSessionList` 上从未传入的 `virtualizeThreshold`；
`ArchivedSessionGroupSection` 里重复的 Mobile/Desktop 映射；把 Profiler
`actualDuration` 当通过条件；只复查第一个组头的第二条测试；`clientHeight` /
`offsetWidth` / `ResizeObserver` 的 jsdom 桩；ceiling 的 `+2` 以及更松的
「少于 1/4 session」断言。

删掉会失败或丢掉产品路径因而保留：滚动口的 `offsetHeight` 桩（没有它对比测试
看到 0 行，变成空窗口用例）；空 range 用例；折叠组不把 session 算进 flatten；
本地项目组头估高；`getItemKey`；虚拟化键盘的 `scrollToIndex`（jsdom 没有覆盖，
但 FocusScope 仍然需要）。
