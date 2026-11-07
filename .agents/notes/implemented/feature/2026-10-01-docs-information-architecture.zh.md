# 文档信息架构

Status: implemented
Translation: current
Language: [English](2026-10-01-docs-information-architecture.md)

## 摘要

公开文档此前是一份按上线历史追加的、包含 30 个条目的扁平 `Features` 列表：新用户没有上手坡道，
Codex / Claude Code 老用户也没有迁移入口。文档现按读者路径重组目录（快速开始、核心概念、实战指南、
从其他 Agent 迁移、功能列表），新增第一次会话教程、概念与术语表、迁移页，并且因为只移动了带括号的虚拟
分组，所有既有文档 URL 保持不变。[Spec](../../../../specs/docs-information-architecture.zh.md)
保持 draft，两种语言都未经母语者审阅，`quota` 与 `usage-and-quota` 的重叠仍未解决。

## 问题

- `index.mdx` 实际上是一份 changelog：一串新能力列表，没有按人群分流。
- `Features` 是 30 个页面的扁平列表；`image-input`、`copy-md` 和 `session-handoff` 在侧边栏里权重
  相同，而且列表只会继续向后追加。
- 快速开始没有走到第一次完整会话就结束了；`workflow` 直接跳到并行工作树和 PR 循环。
- `session-orchestration`、`agent-collaboration`、`parallel-agents`、`session-handoff` 组成了一个
  高度相似的名词簇，却没有一页说明该用哪个。
- 有四个内容页没有任何正文入链；多数页面没有前置条件或下一步。

## 决策

- 遵循 draft Spec [文档信息架构](../../../../specs/docs-information-architecture.zh.md) 的读者路径分组和
  页面约定。
- 页面只在带括号的虚拟分组之间移动，因此所有已发布 URL 不变。
- 新增三个入口页：`(getting-started)/first-session`、`(core-concepts)/concepts`、
  `(migrating)/from-codex-claude-code`，中英文同步。
- 把 `index.mdx` 改写成面向人群的地图，并把 `workflow` 从快速开始移入实战指南。
- 把 `Features` 拆成面向任务的 `(guides)` 和面向能力的 `(reference)`（功能列表下再分四个子组）。
- 在 `session-orchestration` 和 `agent-collaboration` 名词簇顶部增加「我该看哪一页？」提示，并让
  快速开始的下一步指向新入口页。

## 考虑过的替代方案

1. 保留扁平 `Features`，只追加新页面。否决：这不解决导航问题，后续仍会长成同样的形状。
2. 把页面移进真实（不带括号）目录。否决：会改变所有已发布 URL，而站点没有重定向层。
3. 在本次改动里按页面约定重写全部页面。否决：变更过大难以审阅；约定先约束后续编辑和本次触及的页面。

## 验证与限制

- 嵌套的 `(reference)/(...)` 分组和四个子组在中英文侧边栏均正常渲染，每个新增和移动的页面都出现在其
  已发布 URL 上。过滤安装无法构建 site-docs，直到完整工作区安装提供 `app/global.css` 所引用的、被提升的
  `tw-animate-css`。
- 上游撤回移除了误入的 `/coding-agent-gui` 和 `/coding-agent-remote-control` 页面及其路由、页脚/导航链接和
  文档链接；文档首页保留了一个 `Daemon Mode` 锚点链接，供上游 query/fragment 浏览器检查使用。
- URL 稳定性由合并后的构建产物确认，而不只依赖约定：改动前的所有文档 slug 仍存在于
  `out/client`，三个新增文档页在中英文两棵树中也都存在。唯一删除的站点路径是上游撤回的两个
  营销页面。
- `/` 和 `/zh` 的移动端 `no-js navigation` 静态浏览器用例在本次改动前后都超时；此处未调查其原因。
- `quota` 仍然保留为独立的参考页，没有合并或删除，因为删除 slug 需要先做重定向决策；它与
  `usage-and-quota` 的重叠仍待处理。
- 中英文是同时写的，但都没有经过母语者审阅。
