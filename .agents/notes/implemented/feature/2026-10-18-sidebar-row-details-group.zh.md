# 侧栏行详情两段信息归入同一个 Details 组

Status: implemented
Translation: current

[English](2026-10-18-sidebar-row-details-group.md)

## 摘要

Updated 行原本只有一个孤立的 `Show Project` 开关挂在浮层底部，在 Updated 视图之外永远处于禁用态；与此同时 Workspace 行新增了不可关闭的 branch+时间行，有用户想收掉它——再并排追加一根开关只会显得是无结构的堆叠。浮层现在以 `Details` 组收尾，第二行的每段内容各有一个开关（`Show Project`、`Show Branch`），在任何 organize 模式下都可交互，行则把自身携带的段拼进同一条 meta line。代价是：branch 开关关闭时 Workspace 的整条 branch+时间行一起消失，两段全关会让所有两行行退回单行，且默认路径下 Updated 的 repo 行也会开始显示 branch 段。

## 决策

第二行被抽象为一条 meta line，其内容由用户选择，而不是随视图固定的常量。两个持久化偏好控制各段：

- `sidebarUpdatedShowProjectNamesAtom`（沿用既有 key `lody-sidebar-updated-show-project-names`）控制项目段：本地文件夹名或淡化的 GitHub owner 标 + 仓库名，渲染在 Updated 模式的顶层行。
- `sidebarShowBranchNamesAtom`（新增，`lody-sidebar-show-branch-names`，默认 `true` 以保持 Workspace 现状）控制 branch 段：GitBranch 标 + 可截断的分支名，出现在所有顶层携带分支的行——Workspace 的 GitHub 行、本地 worktree 行，以及 Updated 的 repo 行（此前只在 hover card 中可见）。

`sidebar-row-shared.tsx` 的 `SidebarBranchSegment` 负责渲染该段；`SidebarSessionMetaLine` 在 Workspace 行复用它，Updated 行则把项目段与 branch 段拼进同一个 `[data-sidebar-session-meta]` 容器。行高跟随拼装结果：任意一段显示即两行，全关则单行。嵌套 opened 子行在所有状态下保持单行，子行的 tall 连接线（`tallOpener`、`followsTallOpener`）现在会参考 branch 偏好，保证树形几何与 opener 实际渲染的行数一致。移动端行为不变（时间贴右缘、无第二行）。

浮层在 `Details` 组标题下列出两个开关，行几何与 radio 选项一致。开关描述的是持久内容而非当前 organize 模式，因此任何行都不会禁用：禁用行、触摸提示、右侧 tooltip 的整套机制被删除，两个语言包移除 `updatedProjectNamesUnavailable`。切换开关不关闭菜单。新增 i18n key：`sidebar.filter.detailsHeading`、`sidebar.filter.showBranchNames`。偏好变化上报 `settings/changed`，key 为 `sidebar_show_branch_names`。

## 备选与取舍

把一切并入一个"详情行"开关（改动最小）被否决：它牺牲了按段自定义，用户无法在去掉 branch 行的同时保留项目行。继续用两根各自绑定视图的开关也被否决，而这正是本次要修的 append 观感：每根开关一半时间处于禁用态，且菜单从未展示那条隐含的视图从属关系。段拼装模型用同一套控件同时满足"不要两行"的用户（全关）和信息密度优先的用户（全开）。代价是 `Show Branch` 关闭后 Workspace 行上的相对时间一并消失，且 branch 开关无法按视图选择性生效。

## 验证

`sidebar-filter-popover.test.tsx` 覆盖 `view`/`tasks`/`details` 的分组顺序、两个开关在 Project 模式下保持可用、独立回调与切换不关闭菜单。`sidebar-updated-project-context.test.tsx` 覆盖 branch 段追加、无 branch 的 chat 行、嵌套子行、偏好关闭后的收起。`session-list-opened-by.test.ts` 覆盖 Workspace branch+时间行在两种偏好下的表现。组件包 `tsgo` 类型检查仅报两处既有、与本改动无关的错误（`loro-sidebar.tsx` 的 stylex props、`home-week-usage.ts` 的 modelId）；定向套件全部通过。全量组件测试中有六处失败位于工作树其它在途改动（PR 徽章 tone、boot-shell 存储降级、访问控制文案、pending 消息卡片、侧栏宽度），均非本改动触碰。Story 复查：`Sidebar/SidebarFilterPopover` stories 展示两种开关状态，Updated Mode 总览 story 仍是视觉复查的集成面。

相关：
[项目 context](2026-09-20-sidebar-updated-project-context.zh.md),
[显示偏好](2026-09-20-sidebar-updated-project-display-preference.zh.md)
（其底部孤行开关与禁用 tooltip 的决策由本篇取代）,
[本地 repo 行高](../bug-fix/2026-10-18-local-repo-session-row-height.zh.md)。
