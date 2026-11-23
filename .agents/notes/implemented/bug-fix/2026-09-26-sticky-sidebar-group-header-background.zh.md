# 侧栏吸顶分组标题要用 `bg-sidebar`，而不是 `bg-sidebar-background`

Status: implemented
Translation: current

[English](2026-09-26-sticky-sidebar-group-header-background.md)

## 摘要

项目列表很长、向下滚动时，选中项目的选框会透到机器名标题上：吸顶容器用的
`bg-sidebar-background` 是 Tailwind 不会生成的类名（`colors.sidebar` 只定义了
`DEFAULT`，由 `bg-sidebar` 触达），标题的计算背景是 `rgba(0,0,0,0)`。两处吸顶分组
标题——`loro-app-sidebar.tsx` 的机器分组和 `session-list.tsx` 的 Chats/仓库分组
标签——现在共用 `sidebar-row-shared.tsx` 里的 `SIDEBAR_STICKY_GROUP_HEADER_CLASS`
（`sticky top-0 z-10 bg-sidebar`），标题变为不透明，也避免两个调用点再次写岔。
`LoroSidebar.stories.tsx` 新增的 `MachineGroupStickyHeader` 故事在可滚动容器里复刻了
生产 DOM，作为回归覆盖。

## 决策与证据

缺陷随分组标签改造（[deep-sea 配色](../feature/2026-09-25-deep-sea-palette-and-sidebar-groups.zh.md)）
引入：`sticky top-0 z-10 bg-sidebar-background` 看起来像侧栏背景工具类，但
`--sidebar-background` 对应的主题键是 `sidebar.DEFAULT`，所以 `bg-sidebar-background`
解析不到任何规则，标题保持透明。改动前渲染出的标题 `getComputedStyle` 背景为
`rgba(0, 0, 0, 0)`，改动后为 `rgb(25, 26, 29)`；选中项目行（`bg-sidebar-selection` +
`border-sidebar-ring/30`）之前会叠在机器名上，现在从标题下方滑过。

不直观的约束在于：Tailwind 对不匹配主题键的类名静默跳过，一个看似合理的背景工具类
可能带着透明效果上线。把容器收敛到一个共享常量后，后续的分组标题不会再写回那个
拼写。

## 验证与限制

Storybook（深色主题）：列表滚动后，原先选中的第一个项目选框叠在 `LAPTOP-PP66IJ89`
上，现在被不透明标题盖住；标签下方 `space-y-0.5` 的缝隙仍可能露出 2px 的行边，与
其他吸顶分组一致。components 类型检查、侧栏测试、oxfmt 和 `lint:fast` 均通过。仅在
浏览器夹具中验证，未跑 Windows 桌面会话，但成因是 CSS 解析，与平台无关。
