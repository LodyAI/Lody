# 折叠项目分项活动计数

Status: implemented
Translation: pending

## 摘要

旧聚合仅保存一个状态和未读布尔值，无法表达多个 permission 或其他分项数量。
本地项目和 GitHub 项目共用两项摘要：按 permission、unread、active 选择首项，再统计未被首项代表的唯一 Session；保留重叠状态，用图标或混合 `+N` 表示第二项。
GitHub 行保留子 Tab 的分项计数，并从包含置顶 Session 的集合聚合。
代价是行模型增加一个计数字段；展开行的状态和 opened-by 布局保持原有行为。

## 决策与证据

沿用[侧边栏行尾布局](../../../docs/components-sidebar-session-tree.md)，替换旧旋转图标内嵌未读点的方案。
此前尝试每个 Session 只保留一个代表状态；本次按用户确认的 `✋ 1 +1` 撤回该选择：去重计数不等于删除重叠状态。聚合须携带 Session ID，覆盖嵌套及重复输入，排除首项会话后再选择剩余类型并求并集。tooltip 保留可重叠的分项，不能相加作为总会话数。初始化并入「Active」，混合第二项保留首项的单个计数。完整行为见[Spec 草案](../../../../specs/collapsed-project-activity.zh.md)。
LoroSidebar stories 覆盖本地/GitHub 单项、多项、混合计数、状态重叠及展开态。
本次通过 99 个相关测试、864 组独立组合核对、components 类型检查、Storybook 构建、格式及文档检查；lint 无错误，有 6 条既有警告。回归覆盖运行且未读、首项排除、混合并集去重、本地/GitHub 行和子 Tab；提交前完整 `pnpm check` 通过，其中 components 为 450 个文件、3456 个测试，未重跑浏览器视觉验证。
此前版本的 components 全量 3450 个测试及 `pnpm check` 通过；既有浏览器验证覆盖 tooltip、展开/折叠和行尾空间，不作为本次语义修订的验证结论。
Spec 尚未获得修订级审批，翻译待补。
