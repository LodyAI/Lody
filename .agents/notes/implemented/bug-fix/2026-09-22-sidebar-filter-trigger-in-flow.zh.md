# Sidebar 过滤触发器改为行内渲染，不再用测量式覆盖层

Status: implemented
Translation: current

[English](2026-09-22-sidebar-filter-trigger-in-flow.md)

## 摘要

桌面端 sidebar 的过滤触发器原本是一个绝对定位的 `SidebarFilterPopover`，
覆盖在恰好排第一的分区 header 上，由隐形占位 span 预留位置。它的对齐依赖
三个没有写下来的常量（`h-7` 的 header 行、`pt-1` 的包裹偏移、占位盒尺寸）
保持同步，而它们已经悄悄漂移：图标比 header 中线高 4px，比预留槽位偏左
6px。现在触发器直接以 in-flow 方式渲染在第一个 header 的 `action` 槽里，
由行内 flexbox 保证对齐，不再有像素契约。弹窗的 `open` 状态上移到
`loro-app-sidebar`——所有候选槽位的公共祖先——因此单一实例在新槽位重挂载
不再导致弹窗关闭，这也正是当初引入覆盖层的原因，现在被替代了。

## 决策

`loro-app-sidebar` 创建一个受控 `open`/`onOpenChange` 的
`SidebarFilterPopover` 元素，渲染进第一个本地项目分区 header（没有本地
分区时则为 GitHub Worktrees / Chats header），门控逻辑与原占位完全镜像。
同一个元素以 `desktopFilterAction`（由 `desktopFilterPlaceholder` 改名）
传给 `LoroSidebar`，用于它内部拥有的槽位——Pinned 和 Updated 列表 header。
各处门控保持互斥，每次渲染只存在一个挂载点。`LoroSidebar` 保留一个本地
非受控兜底实例，供未传该 prop 的直接使用方（如 stories）。覆盖层包裹和
两种尺寸的占位 span 全部删除。`SidebarFilterPopover` 接受可选的受控
`open` props，否则保留内部状态，因此移动端底部的实例不受影响。

每个 header action 渲染点统一给 action 加 `mr-2`/`pr-2` 内缩——
`SidebarSectionHeader` 的包裹层、session-list 组头、以及独立的
`justify-end` action 行（SessionList 的加载/空态兜底和 updated 列表的
`HeaderActionRow`）。这把原覆盖层的 `right-2` 几何以 in-flow 方式保留：
触发器右缘落在 `px-2` 会话行所建立的内容盒右缘上，图标中心对正行尾状态列
（未读点轴 cx 295，触发器 cx 296，与原覆盖层的 1px 偏移一致）。没有这条
内缩时触发器贴行右缘，比该列偏右 8px——内缩是 header 行的属性而非
action 元素自身的属性，因此对任何 action 内容都成立。

上移 `open` 是归属正确而非无谓上移：触发器的位置由位于所有候选槽位之上的
sidebar 布局层拥有，而弹窗的其他状态（organize 模式、任务范围、labels、
变更回调）本来就都在那里——`open` 是唯一漏网的非受控状态。考虑过的替代
方案：测量占位元素的 DOM rect 来驱动覆盖层（状态不必上移，但要引入
ResizeObserver，且仍保留两份事实来源），以及 Radix `Popover.Anchor` 配合
`virtualRef`（管道复杂度相近）。两者都保留了"视觉上有依赖、布局上无约束"
的结构，而这正是本次缺陷的根源。

## 验证

在镜像生产 topContent 组合的 `Components/LodySidebar` storybook story 中，
Local Projects header 内的文字、导入按钮、过滤触发器实测中线一致（28px 行
的 centerY 均为 278px），触发器中心与会话行状态列差 1px（cx 296 vs
295——与原 `right-2` 覆盖层的偏移相同），弹窗可正常打开并锚定到触发器。
改动的文件通过 `tsgo --noEmit` 和 `oxlint`。"弹窗打开期间第一个分区发生变化"（例如同步
带来一个置顶会话）这一情形由受控状态覆盖，但仅经推理验证，未在运行的
应用中实测。

## 集成

- [Lody PR #884](https://github.com/LodyAI/Lody/pull/884)
