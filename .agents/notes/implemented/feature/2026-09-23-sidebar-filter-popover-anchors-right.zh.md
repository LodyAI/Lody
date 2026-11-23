# Sidebar 过滤弹窗改为锚定在侧栏右侧

Status: implemented
Translation: current

[English](2026-09-23-sidebar-filter-popover-anchors-right.md)

## 摘要

桌面端 sidebar 的过滤弹窗原本从行内分区 header 触发器向下打开
（`side="bottom" align="end"`），会盖住它正在控制的会话列表。现在改为向右
侧的浮出菜单（`side="right" align="start"`），弹到侧栏旁边的内容区，顶边与
触发器所在行齐平。移动端底部的实例保持默认的 top-start 锚定不变。

## 决策

`SidebarFilterPopover` 本来就暴露 `side`/`align`，改动只涉及三个桌面端渲染
点：`loro-app-sidebar` 持有的实例、`LoroSidebar` 留给直接使用方（stories）
的非受控兜底实例、以及镜像生产组合的 `LoroSidebar` story。`align="start"`
让菜单顶边对齐触发器顶边，表现为贴着 header 向右展开的浮出菜单，而不是以
按钮为中心的悬浮面板。窗口过窄、右侧空间不足时仍由 Radix 的碰撞处理自动翻
转，无需另加兜底逻辑。移动端实例不动：它的触发器在底部栏里，默认的向上锚
定依然是正确的。

## 验证

已在 Storybook 中实测：`Components/LodySidebar` 的 Default story（镜像生产
的 `WithProjectsLayout`）下，弹窗原本向下打开、盖住会话列表；改动后从
Local Projects 行高齐平处向侧栏右侧弹出，列表不再被遮挡。新取值仍在既有
prop 联合类型之内，改动文件通过 `oxfmt --check`。该嵌套 worktree 未安装依
赖（嵌套 checkout 跳过 `pnpm install`），此处无法完整跑 `tsgo`/`vitest`。
