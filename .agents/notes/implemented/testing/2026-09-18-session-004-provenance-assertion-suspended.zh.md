# 暂停 LODY-SESSION-004 中依赖归档路由的溯源断言

Status: implemented
Translation: current

[English](2026-09-18-session-004-provenance-assertion-suspended.md) | 中文

## 摘要

`LODY-SESSION-004` 在[归档级联修复记录](2026-09-17-daily-e2e-cascade-and-windows-tags.md)
对齐契约后仍然每天 Daily 失败：它最后一个检查点会打开每个已归档幸存
Session 的路由，并期望 `opened-by` 卡片渲染 `Deleted session`。自 #746
起（`isSessionTabClosed` 把 `isArchived` 视为已关闭 Tab），该路由会回退到
empty/draft Tab，卡片因此从不挂载。wibus-wee 判断该跳转属于可接受的产品
行为而非已确认的缺陷，因此在归档视图 UX 明确之前先将该 Gherkin 步骤注释
停用。registry 行、其指纹和 `COVERAGE.md` 已按缩短后的场景重新生成；这次
失败从未证明溯源已丢失，保留情况可以在 doc-meta 层（`openedBySessionId`）
重新验证，无需渲染卡片。

## 证据

- Daily run 35317896229（commit `3bb73abe`，已包含级联修复）：macOS 和
  ubuntu 仅在该场景失败于 `expectDanglingProvenanceAndCleanup`；定位器
  `[data-session-relation-card="opened-by"]` 超时并报告
  `element(s) not found`。
- 机制：`archive-view.tsx` 行点击导航到普通 `/sessions/{id}` 路由；
  `closedConversationIds` 包含已归档的根 Session，因此
  `getSessionTabFallback` 将请求的 Tab 解析为 `empty`/某个 draft 并重写
  URL。`isSessionTabClosed` 与该回退由 #746 于 2026-09-16 引入；在此之前，
  已归档 Session 会渲染其历史并附带恢复/删除菜单动作。
- 相关发现：`restoreSession` 只翻转 `isArchived`/`isTabClosed` 元数据，
  不会重建被回收的 worktree；且本地项目被移除后
  `assertArchivedLocalProjectCanRestore` 使恢复不可用，因此"先恢复再查看"
  的 UX 会让一部分归档历史永远无法触达。

## 决策

`session-management.feature` 中注释停用了步骤
`child Tab 被删除而 opened Sessions 保留 dangling 溯源并可独立清理`，理由
就地写明；步骤定义和 Page Object 方法保持注册，重新启用无需改代码。场景
仍验证级联、资源释放和限定范围的永久删除；registry 检查点移除了
`session.openSurvivors` 动作和两条溯源检查点，指纹已用
`journeyFingerprint` 重算。

重新启用（或改用 doc-meta 层 `openedBySessionId` 断言）等待归档视图 UX
定论：`/sessions/{archived}` 应渲染只读历史并附恢复/删除入口——#746 之前
的行为正是如此，现已失效的菜单分支也印证了这一意图——还是必须先恢复
才能查看。

## 验证与限制

`pnpm e2e:check` 覆盖套件契约、指纹、dry-run 和类型检查；场景本身未重跑
（需要构建好的桌面端）。被停用的步骤同时覆盖了幸存者的独立删除，因此
journey 不再证明已归档 Session 可从自身路由删除——该流程同样被未决的
归档视图 UX 阻塞。
