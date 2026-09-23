# 让被打开的 Session 不受开启者状态级联影响

Status: implemented
Translation: current

Contract: [Session 关系与操作目标](../../../../specs/session-relations.md)

[English](2026-09-10-session-containment-lifecycle.md)

## 摘要

桌面端与移动端的操作把「由谁打开」的来源关系当成了生命周期归属，因此对开启者执行操作可能停止或
删除一个独立的 Session 及其 worktree。归档、恢复与「归档根的永久删除」现在只遵循直接的
`parentSessionId` 包含关系。精确清理只删除调用方给出的 Session id。存活的 Session 保留「由谁打开」
的来源信息，而反向导航只在其目标确认存在时才可用。

## 证据与决策

[#528](https://github.com/LodyAI/Lody/issues/528) 中的不一致确实存在，但把 CLI/MCP 的级联扩大只会
固化错误的归属模型。被打开的 Session 是一等 Session，拥有自己的工作区、机器、项目与生命周期；
`openedBySessionId` 与 `openedByRootSessionId` 记录的是来源与导航。而子 Tab 携带的是
`parentSessionId`，并与其根 Session 共享生命周期。

桌面端/移动端的归档行为遵循 [#531](https://github.com/LodyAI/Lody/issues/531)。归档、恢复与归档根
删除会选中根，以及缓存中 `parentSessionId` 等于根 id 的条目。这刻意是一条一层、操作局部的规则：
受支持的产品路径不会创建嵌套的子 Session，CLI/MCP 同样只选择直接子项。通用的
`collectSessionLifecycleIds` 图已被移除，因为并不存在横跨包含关系与来源关系的统一生命周期树。

`deleteSessions(ids)` 是独立的精确清理 API。其调用方本就知道要移除的是哪个创建失败的子项、空 Tab
或侧边 Session，因此它既不发现相关 Session，也不等待元数据水合。基于发现的
`deleteArchivedSession(rootId)` 保留就绪闸门，因为从不完整缓存中选取其额外的直接子项是不安全的。

删除开启者不会改写存活 Session 的 `openedBySessionId` 或 `openedByRootSessionId`；这些字段保留
因果事实。元数据缓存就绪之后，反向导航要求精确的开启者及其路由根都存在。因此缺失的目标会渲染为
不可点击的「已删除会话」来源，而不是跳转到 `SessionNotFound`。归档根的永久删除在元数据缓存完整
之前拒绝选择目标，因此不完整的缓存不会在破坏性操作中静默漏掉某个直接子项。本缺陷不需要墓碑模型：
存活的 Session 本就保留着不可再简化的 id。

归档的展示逻辑仍独立存在于
[`buildArchivedSessionTree`](../../../../packages/components/src/lib/archived-session-tree.ts)，
它仍可能把两个各自独立归档的 Session 展示为缩进关系。

状态/结果聚合、未读与权限路由、worker 面板、settle 以及
[#529](https://github.com/LodyAI/Lody/issues/529) 中的交接都不在本次修复范围内。

## 验证

回归覆盖建模了一个根 Session、它的子 Tab、一个独立打开的 Session，以及一个从该 Tab 打开的 Session。
归档、恢复与归档根删除只影响根与 Tab；精确删除即使在元数据水合完成之前也只移除给定的 id。「先归档
再删除」的序列把这些 Session 放在同一台机器上，并验证存活的文档、worktree 删除命令、启动配置与
旧版队列都未被触碰。导航测试覆盖部分水合、开启者被删除与路由根被删除的情形；UI 测试验证悬空来源
不提供任何可点击操作。ACP 终止重试在 RPC 边界上是幂等的：运行时消失后，Session 管理器返回
`not-found`，终止 handler 仍将其报告为成功响应。

归档与恢复的目标仍来自 `sessionMetaCacheAtom`。该缓存由一次完整的元数据扫描填充，扫描完成后
`docMetaCacheReadyAtom` 才为 true，但 Session 详情页可能在扫描结束之前就为一个已渲染的 Session
提供归档入口。因此一个尚未进入缓存的直接子项可能被漏掉。就绪或完整查询的契约及其回归覆盖记录在
[#574](https://github.com/LodyAI/Lody/issues/574)，而不是扩大本次归档语义修复的范围。

操作、导航、关系卡片、头部菜单与归档树五个套件拥有定向回归覆盖。桌面端旅程 `LODY-SESSION-004`
用两个真实的 worktree fork 演练完整用户序列：归档与归档根删除会移除开启者及其子 Tab，而被打开的
Session、它们的 ACP 进程与 worktree 全部存活。随后它打开两个存活者，验证已删除来源不可导航。同一
旅程还让真实的初始元数据 Flock 扫描跨渲染进程重载被延迟，并关闭一个由实时元数据事件填充的空子 Tab，
证明精确清理在完整水合之前依然可用。仓库级检查结果记录在 PR 状态中，不在此重复。该旅程在拆除之前
会等待每一次被阻塞的元数据扫描与规范的根 Tab 路由，因此运行时证据不会与水合触发的导航发生竞态。
运行配置菜单步骤接受已选中的 Agent，并使用键盘激活子菜单。Fork 步骤同样使用键盘激活，并通过项目
工作目录识别源 ACP Session，从而避免 hover 卡片拦截与并发的标题 agent 事件。
