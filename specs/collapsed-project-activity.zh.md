# 折叠项目活动聚合

Status: draft
Translation: pending

折叠本地项目或 GitHub 项目后，在项目名称右侧、操作按钮之前显示最多两项活动摘要。
保留项目展开按钮、opened-by 树和 Session 行尾状态；展开项目时隐藏摘要。
本地项目等待移除或正在移除时，行尾显示移除进度。

- 按 permission、unread、active 的顺序显示首项及数量；数量为 1 时通常省略，第二项为混合 `+N` 时保留首项的 `1`，明确两个数字的归属。
- 剩余类型只有一种时，第二项显示该类型及数量；剩余类型有两种时显示合计 `+N`。
  例如 `✋ 1 +5`、`● 3 ↻ 2`、`↻`，不添加第三个图标。
- permission 和 active 取自新鲜的 Session presence；running、initializing 均计入 active，
  使用现有 running 图标。等待 permission 不重复计入 active。
- 包含置顶 Session 及未归档子 Tab，每个 Session 在每种状态中只计一次。
  未读结果独立计数，可与该 Session 的实时状态共存；数量表示状态数，不是去重后的会话总数。
- 无活动时不显示摘要。可访问性标签和 tooltip 保留全部分项计数，包括被 `+N` 合并的类型。

## 实现与验证依据

[计数与选择](../packages/components/src/components/project-activity.ts)、
[行渲染测试](../packages/components/tests/project-activity.test.tsx)、
[既有 Storybook](../packages/components/src/stories/LoroSidebar.stories.tsx)。
验证结果见[实现记录](../.agents/notes/implemented/feature/2026-09-09-collapsed-project-activity.zh.md)。
