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
| 归档           | 本身及沿包含关系、精确 opened-by 关系递归找到的后代；客户端元数据缓存未完整时，在任何写入前拒绝 |
| 恢复           | 本身和直接子 Tab；发现目标应使用完整元数据                                                      |
| 永久删除归档根 | 本身和直接子 Tab；缓存未完整时拒绝                                                              |
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

## 范围与实现限制

归档要求客户端缓存完整。对已经归档的根再次归档仍会处理后代。写入幂等但非事务；
写入失败向调用方报错，可重试。每个归档目标继续遵循已有的运行时停止与 worktree 清理规则。

恢复仍可能在缓存未完整时遗漏子 Tab；原有 #574 跟踪元数据完整性问题。
worker 监督、状态聚合、未读及权限路由、worker 面板和交接行为不在此契约内。

## 证据

客户端入口为 `packages/components/src/hooks/use-session-actions.ts`，CLI 入口为
`apps/cli/src/commands/session.ts`；MCP 归档调用 CLI。共享归档选择器为
`packages/shared/src/session-archive-targets.ts`。两端已有的 action/command 测试覆盖行为。
反向导航由 `packages/components/src/lib/session-navigation.ts` 负责。

#569 实现了原本仅按包含关系操作的基线；
[后代归档决策](../.agents/notes/implemented/bug-fix/2026-09-13-session-archive-descendants.zh.md)
替代其中的归档规则。本修订仍为 draft。
