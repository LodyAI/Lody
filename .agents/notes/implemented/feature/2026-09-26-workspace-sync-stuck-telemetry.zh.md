# 上报卡在数据就绪之前的工作区

Status: implemented
Translation: current

[English](2026-09-26-workspace-sync-stuck-telemetry.md)

## 摘要

用户有时会一直停在“Syncing workspace…”，而我们对此一无所知：这个状态是推导出来的就绪门槛，不是失败；
它最可能的原因——首次 doc-meta 扫描被拒绝——此前被静默吞掉，没有任何痕迹。现在工作区就绪判定会说明
是哪个条件卡住了，扫描失败会记在 scope 上；一个始终挂载的上报组件在等待 30 秒后发送一次
`workspace/sync_stuck` 事件，连接本身在线时再向错误追踪上报 `WorkspaceSyncStuckError`，等待结束时发送
带总时长的 `workspace/sync_stuck_resolved`。这只是观测：失败的扫描目前仍不会重试，失败的工作区会一直卡住，
直到 runtime 被替换，但现在它会被计数并说明原因。

## 问题

侧边栏的“Syncing workspace…”和内容区的“Switching workspace”占位，都表示 `resolveWorkspaceDataScope`
返回了 `switching`。这发生在连接在线的时候，所以现有的连接卡住提示（`use-stuck-connection.ts`，只看
`loading`）覆盖不到它，也没有任何遥测。`resolveWorkspaceDataScope` 对五种不同原因返回同一个值，
连日志都说不出是哪一个。

首次 doc-meta 扫描以 `void buildDocMetaCache(...).then(...)` 启动，没有拒绝处理。扫描被拒绝后
`docMetaCacheScopeAtom.ready` 永远为 false，且什么都不报——这正是无尽的“Syncing workspace…”。

## 决策

- **说出卡点。** `switching` 状态的 `WorkspaceDataScopeState` 带上 `blocker`：`runtime_missing`、
  `runtime_other_workspace`、`doc_meta_scan_pending`、`doc_meta_scan_failed`、
  `workspace_not_in_organizations` 或 `workspace_id_mismatch`，按判定顺序。产品代码仍只读 `status`。
- **保留扫描失败。** 首次扫描被拒绝时，在 scope 上设置 `scanFailure: { errorType }` 并打印警告。
  不保存错误消息：它可能包含流地址。
- **从叶子组件上报，不放在侧边栏。** `WorkspaceSyncStuckReporter` 不渲染任何内容，与
  `LodyLiveActivityHost` 一起挂在两种工作区布局里。侧边栏并不总是挂载（紧凑和移动布局在关闭时会卸载它），
  而用户无论如何都卡在内容占位后面。叶子组件使用路由的就绪输入（与 `useResolvedWorkspaceScope` 一样，以
  `currentWorkspaceIdAtom` 作为组织信号），因此不会再启动一个带自身重试计时器的组织查询。
- **每次等待只报一次。** 未就绪满 30 秒后，hook 发送一次 `workspace/sync_stuck`，包含上报时的卡点、
  已等待时长、控制连接状态与 UI 连接状态、浏览器在线状态、组织就绪、扫描错误类型和页面可见性。
  等待结束时发送 `workspace/sync_stuck_resolved`，`resolution` 为 `ready`、`target_changed` 或
  `unmounted`。
- **仅在线时进入错误追踪。** 只有连接 UI 状态为 `online` 时才上报 `WorkspaceSyncStuckError`。
  离线和重连已经向用户解释了等待，不是 bug；它们仍然产生分析事件，看板可以按 `connection_ui_state`
  拆分。错误消息包含卡点，因此错误追踪按卡点分组为不同 issue。
- **也写本地痕迹。** 每次上报和结束都会写一行 console 日志和一行 session render trace，
  卡住期间或之后复制的崩溃报告里就能看到。这是本地开源构建唯一能得到的信号：它们不创建 PostHog 客户端，
  调用进入那个在本地永远不会初始化的延迟客户端。

## 未采用的方案

- **把 hook 放在 `LoroAppSidebar`。** 它拥有那个状态胶囊，但侧边栏卸载期间的所有卡住都会漏报。
- **在叶子组件里调用 `useOrganization`。** 能与胶囊的组织信号完全一致，但每个实例都会运行自己的重试计时器
  和工作区上下文写入。对扫描和 runtime 这类最可能的卡点，两种信号是一致的。
- **重试失败的扫描。** 这是一个有自身风险的恢复改动（例如对失败的仓库形成重试风暴）。留作后续；
  新的 `doc_meta_scan_failed` 计数会说明是否需要。

## 分析

事件为 `workspace/sync_stuck`（tier A，不采样）和 `workspace/sync_stuck_resolved`。有用的切分：
按 `blocker` 与 `connection_ui_state` 统计卡住次数；按 `resolution` 看已结束事件的 `stuck_ms` 分布；
从未结束的卡住比例（同一会话里有卡住事件却没有结束事件，通常意味着用户退出或刷新）。
错误追踪按卡点列出 `WorkspaceSyncStuckError`。

## 验证

- `tests/use-workspace-sync-stuck-report.test.tsx` 使用假计时器和捕获式 PostHog 客户端：阈值前不上报、
  每次等待只报一次、上报时的卡点与连接状态、离线时不上报异常，以及每种结束方式。
- `tests/workspace-data-scope.test.ts` 断言每个卡点。
- `tests/doc-meta-subscription.test.ts` 断言被拒绝的扫描会记在 scope 上。
- 尚未在真实卡住的用户身上验证：30 秒阈值是判断，应由首批线上数据确认或调整。
