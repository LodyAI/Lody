# 恢复关闭未发过消息的 session tab 时的精确删除

Status: implemented
Translation: current

[English](2026-09-18-empty-tab-close-exact-delete.md) | 中文

## 摘要

`LODY-SESSION-004` 的冷 hydration 步骤——在 #812 挂起 provenance 断言
之后才第一次被执行到——在 #813 的第一次 e2e-full 上失败：关闭一个空
child tab 后，它的 session doc 一直留在 `repo.listDoc()` 里。原因是
#746（"workspace-shared session tab closure"）在重写
`handleTabClose` 时丢掉的分支：旧代码对从未发过消息的 tab
（`!lastMessageAt`）做精确删除、对其余归档，而重写后所有关闭都只写
`isTabClosed`——于是每个被关掉的空 tab 都变成一条不可见的持久化
doc。本次恢复保留非空 tab 的 `isTabClosed` 新模型，但加回精确删除
分支，并且判空改走 `runtime.repo.getDocMeta` 而不是旧代码用的
`childSessions` 列表——因为该场景显式验证"metadata 扫描缓存仍冷时
精确删除也必须工作"。`pnpm e2e:check` 通过；最终由 daily 证实。

## 证据

- #813 第一次 e2e-full（run 35359528422）：21/22 通过；唯一失败是
  `LODY-SESSION-004` 的 `expectColdHydrationExactDelete`
  （`session-relation-lifecycle-page.ts:200`），`Expected: false,
  Received: true`——被关掉的空 tab 的 `session-{id}` doc 在 30 秒
  轮询内始终存在于 `repo.listDoc()`。
- `git show 884ec6ce~1`（#746 之前的 `handleTabClose`）：
  `if (tabMeta && !tabMeta.lastMessageAt) await deleteSessions([id])
  else await archiveSession(id)`。当前代码无条件调用
  `setSessionTabClosed`——components、shared、CLI、electron 里都不
  再有删除空 closed tab 的路径。
- 契约仍以注释形式存活：`use-session-actions.ts` 仍写着 "empty tabs
  are deleted, not archived"；shared AGENTS.md 明确
  `deleteSessions(ids)` 不依赖 discovery 和缓存就绪——这正是场景里
  metadata 扫描屏障所验证的。

## 修复

- `session-detail.tsx` 的 `handleTabClose` 通过
  `runtime.repo.getDocMeta` 直读 tab 的 meta——不依赖扫描缓存状
  态——`!lastMessageAt` 时调用 `deleteSessions`；非空 tab 维持
  #746 的 `isTabClosed` 写入。
- 删除的是活跃 tab 时 handler 自己导航回路由 session tab：
  `resolveActiveSessionTab` 刻意让缺 meta 的 `session:` tab 保持活跃
  （被删 doc 与"副本尚未同步"不可区分），而 shared-close effect 只看
  `isTabClosed` meta——handler 不导航的话 URL 会永远停在已删 tab
  上。#814 第一次 e2e-full 验证了这一点：删除已通过，`toHaveURL`
  到父 tab 超时。
- `isLoroRepoDocDeleted` 护栏与 `setSessionTabClosed` 的错误契约一
  致；meta 缺失时落入 `setSessionTabClosed`，沿用原有的
  "metadata is still loading" 报错。
- 重新发出 `session/tab_deleted_empty` 事件（沿用 #746 前分支的事
  件名），让两种关闭结果在分析中仍可区分。
- `sessions/AGENTS.md` 已更新："Close writes `isTabClosed`, never
  archive — a tab that never had a message is exact-deleted instead."

## 权衡过的替代方案

- 像 provenance 断言（#812）一样挂起这个 e2e 步骤：否决——本次失败
  是被删掉的代码分支加上仍存活的契约注释，不是未定 UX；挂起会把
  "空 tab 残留 doc"这个回归藏起来。
- 把判空放进 `setSessionTabClosed` 内部：否决——该 hook 的名字承诺
  的是写标记，破坏性删除应留在显式的关闭处理器里，与 #746 前的结
  构一致。

## 验证边界

`pnpm e2e:check` 和 components 单测通过；本嵌套 checkout 的
electron typecheck 报错是已知的缺依赖环境问题。冷 hydration 步骤
只能由 e2e-full 或 Daily 证实；断言本身自 #583 起未变，跑一次绿腿
即可同时为恢复与冷 hydration 路径闭环。
