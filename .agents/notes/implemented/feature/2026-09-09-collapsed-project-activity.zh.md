# 折叠项目分项活动计数

Status: implemented
Translation: pending

## 摘要

旧聚合仅保存一个状态和未读布尔值，无法表达多个 permission 或其他分项数量。
本地项目和 GitHub 项目现在共用两项摘要，遵循 permission、unread、active 优先级。
GitHub 行保留子 Tab 的分项计数，并从包含置顶 Session 的集合聚合。
代价是行模型增加一个计数字段；展开行的状态和 opened-by 布局保持原有行为。

## 决策与证据

沿用[侧边栏行尾布局](../../../docs/components-sidebar-session-tree.md)，替换旧旋转图标内嵌未读点的方案。
未读仍可与实时状态共存；初始化并入 active，聚合标签统一为「Active」。混合 `+N` 按未被首项表示的 Session 去重，并保留首项的单个计数，避免重复计数及数字归属歧义。完整行为见[Spec 草案](../../../../specs/collapsed-project-activity.zh.md)。
LoroSidebar stories 覆盖本地/GitHub 单项、多项、混合计数、状态重叠及展开态。
components 全量 450 个文件、3453 个测试通过；相关 2 个文件、76 个测试通过。
Storybook 构建通过；既有浏览器验证覆盖 tooltip、展开/折叠和行尾空间。
`pnpm check` 全量通过（含 typecheck、lint、test:ci、i18n 与边界检查）；format 和 docs check 通过。
Spec 尚未获得修订级审批，翻译待补。
