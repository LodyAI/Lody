# 折叠项目活动聚合

Status: draft
Translation: pending

折叠本地项目或 GitHub 项目后，在项目名称右侧、操作按钮之前显示最多两项活动摘要。
保留项目展开按钮、opened-by 树和 Session 行尾状态；展开项目时隐藏摘要。
本地项目等待移除或正在移除时，行尾显示移除进度。

- 保留每个 Session 可重叠的状态；项目按 permission、unread、active 选择首项，数量为该状态的唯一 Session 数。
- 数量为 1 时通常省略，第二项为混合 `+N` 时保留首项的 `1`，明确两个数字的归属。
- 第二项先排除首项已代表的 Session：剩余状态只有一种时显示该类型及数量；有两种时显示 Session ID 并集大小 `+N`，不相加状态次数，`+1` 有效。
  例如 `✋ 1 +5`、`● 3 ↻ 2`、`↻`，不添加第三个图标。
- permission 和 active 取自新鲜的 Session presence；running、initializing 均计入 active，
  使用现有 running 图标，聚合标签统一为「Active」。等待 permission 不重复计入 active。
- 包含置顶 Session 及未归档子 Tab；重复输入按 Session ID 去重。状态分项可重叠，但同一 Session 不会在两个展示项中重复计数。
  例如 A 等待 permission、B 同时 running 和 unread，显示 `✋ 1 +1`；仅 B 时显示 `●`，不会因其 active 再生成第二项。Session 行原有状态优先级和已读记录不变。
- 无活动时不显示摘要。可访问性标签和 tooltip 保留全部状态分项并使用「Active」标签；分项可能重叠，不能相加作为会话总数或 `+N`。

## 实现与验证依据

[计数与选择](../packages/components/src/components/project-activity.ts)、
[行渲染测试](../packages/components/tests/project-activity.test.tsx)、
[既有 Storybook](../packages/components/src/stories/LoroSidebar.stories.tsx)。
验证结果见[实现记录](../.agents/notes/implemented/feature/2026-09-09-collapsed-project-activity.zh.md)。
