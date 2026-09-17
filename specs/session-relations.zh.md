# Session 关系与操作目标

Status: draft
Translation: current

[English](session-relations.md)

## 关系

根对话 A 可以包含子 Tab T（`parentSessionId=A`），也可以创建独立对话 B
（`openedBySessionId=A`）。T 创建 C 时，C 记录精确来源 T，并以
`openedByRootSessionId=A` 补充可路由的根。独立对话保留自己的工作区。

归档 A 包含 A、T、B、C 以及它们继续创建的后代。恢复和删除仍按包含关系选择目标。

| 操作           | 目标及要求                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- |
| 归档           | 本身及沿包含关系、精确 opened-by 关系递归找到的后代；从就绪的 Repo 读取一份快照，不依赖 UI 投影 |
| 恢复           | 本身和直接子 Tab；从就绪的 Repo 读取一份快照，不依赖 UI 投影                                    |
| 永久删除归档根 | 本身和直接子 Tab；从就绪的 Repo 读取一份快照，不依赖 UI 投影                                    |
| 精确删除       | 仅调用方传入的 id；不要求全局缓存就绪，供创建补偿及显式清理使用                                 |

仅支持一层 Tab 包含，创建路径拒绝嵌套 Tab。独立对话可继续创建对话；归档遍历去重并防止循环。
一个条目同时具有两种关系时，包含关系优先。单独的 `openedByRootSessionId` 不作为归档边。
列表过滤、置顶、折叠不影响归档目标。来源关系不赋予恢复或永久删除的所有权。

恢复 A 只恢复 A 和 T，B、C 可分别恢复。永久删除 A 只删除 A 和 T，B、C 仍存在。
精确删除 T 只删除 T。终端关闭、运行时释放、启动配置及 worktree 清理必须遵循各操作的目标集。

## 删除后的来源

删除开启者后，存活对话保留 `openedBySessionId` 和 `openedByRootSessionId`。
元数据加载完成后，只有精确来源和路由根都存在时才能反向导航；否则可展示已删除来源，
不得导航到不存在的 Session。不要求保存墓碑标题。归档列表仍可按来源缩进显示，
但显示关系不扩大恢复或删除目标。

## 就绪、生命周期与失败

根验证与目标发现使用同一份存活 Session 元数据快照，由文档 room id 确定身份，排除删除条目。
读取失败、根不存在或已删除时，在写入和终端关闭前拒绝，不回退到 UI 缓存。
UI 元数据 readiness 只负责展示，不是业务目标发现的边界。

runtime 必须已完成所选元数据源的首次同步。桌面本地操作使用本地数据平面，不要求云端连通。
CLI 的归档、恢复和删除均须在发现目标前成功同步元数据，即使初始化曾降级继续。

操作捕获 runtime，并在第一次写入前确认仍为当前实例。开始写入后固定使用该 runtime 和目标集。
保证范围是所观察到的 Repo 快照，不包括离线副本，也不构成阻止后续创建的原子屏障。
精确删除和普通 Tab 关闭不依赖此发现边界。

归档写入幂等但非事务，失败向调用方报错，之前的目标可能已归档；对已归档根重试仍重新发现后代。
成功写入继续触发既有运行时停止与 worktree 清理；终端关闭在各次写入成功后尽力执行。
回滚元数据无法撤销资源停止。永久删除先处理子会话，再处理根。

worker 监督、状态聚合、未读及权限路由、worker 面板和交接行为不在此契约内。

## 证据

客户端入口为 `packages/components/src/hooks/use-session-actions.ts`，CLI 入口为
`apps/cli/src/commands/session.ts`；MCP 归档调用 CLI。共享归档选择器为
`packages/shared/src/session-archive-targets.ts`。两端已有的 action/command 测试覆盖行为。
反向导航由 `packages/components/src/lib/session-navigation.ts` 负责。

#569 实现了原本仅按包含关系操作的基线；
[后代归档决策](../.agents/notes/implemented/bug-fix/2026-09-13-session-archive-descendants.zh.md)
替代其中的归档规则。本修订仍为 draft。
[Repo 快照决策](../.agents/notes/implemented/architecture/2026-09-17-session-operation-metadata-snapshots.zh.md)
通过两端共用的 [快照读取入口](../packages/shared/src/session-operation-targets.ts)
修复 [#574](https://github.com/LodyAI/Lody/issues/574) 的发现缺口，不改变关系规则。
