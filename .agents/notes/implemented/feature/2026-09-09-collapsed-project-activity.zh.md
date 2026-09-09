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
未读仍可与实时状态共存；初始化并入 active。完整行为见[Spec 草案](../../../../specs/collapsed-project-activity.zh.md)。
既有 LoroSidebar stories 覆盖本地/GitHub 单项、多项、混合计数及展开态。
components 全量 443 个文件、3337 个测试通过；相关 6 个文件、132 个测试通过。
浏览器验证 32 个 Storybook 场景，以及 tooltip、展开/折叠和行尾空间。
补充折叠状态对照页，本地/GitHub 各 18 组，覆盖无活动、单项、两项、三项及较大计数；浅色/深色共 72 组浏览器检查通过。
对照页与独立 stories 共用 Session 数据生成和项目参数定义，避免重复维护；场景与测试覆盖保持完整。
`pnpm check` 全量通过（含 typecheck、lint、test:ci、i18n 与边界检查）；format 和 docs check 通过。
Spec 尚未获得修订级审批，翻译待补。
