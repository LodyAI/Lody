# 让侧栏机器状态在 presence 重连时保持稳定

Status: implemented
Translation: current

[English](2026-10-24-sidebar-offline-pill-flicker.md)

## 摘要

侧栏机器名后的「离线」徽标会周期性消失再出现。原因是只要 presence 同步状态
不是 `synced`，徽标就会被隐藏；而 Streams SDK 在其 SSE 读取循环回收时会短暂
报告 `reconnecting`，即使保留下来的 presence store 仍持有上一份快照。presence
transport 现在维护独立的展示状态：短暂的原地重连会在五秒内保留上一次
`synced`，原始状态仍立即驱动恢复。替换 store 的重启、终止性故障和显式停止
不会被隐藏；限制是超过该窗口的重连仍会让徽标消失。

## 问题

`SidebarMachineOfflinePill` 只在 `useMachineOnlineStatus` 返回 `offline` 时渲染。
一旦 `lodyPresenceSyncStateAtom` 离开 `synced`，该 atom 就返回 `unknown`，而
该 atom 原先与 SDK 的 transport 状态一一对应。在
`@loro-dev/streams-crdt` 中，SSE 读取循环正常结束会把 read 子状态设为
`reconnecting`，重算总状态并重连。因此例行服务端流回收或由空闲触发的重试，
即使 store 未被重建、快照仍然有效，也会发布真实的 `reconnecting`。工作区里
每台机器都会从 `offline` 短暂变成 `unknown`（无徽标），重连完成后再变回来。

三态规则要避免的是「本客户端看不到 presence 时却声称机器离线」；它并不要求
socket 一重连就忘掉刚刚拿到的快照——快照对「缺席」的证据仍然只比最后一次
应用的更新旧一点。

## 决定

`WorkspacePresenceTransport` 在原始同步状态之外新增展示同步状态：

- 展示状态通常等于原始状态；但当已 `synced` 的房间进入 `connecting` 或
  `reconnecting` 且未替换 store 时，它继续保留 `synced`，最长
  `PRESENCE_SYNC_DISPLAY_GRACE_MS`（5 秒）。
- 窗口内恢复会取消待执行的降级，不发出任何 UI 状态；窗口结束后发布当前
  原始状态。
- 终止状态（`error`、`disconnected`）立即发布。
- `start()` 会替换 store，因此其 `connecting` 绕过宽限；新 store 的空快照
  不能继承旧房间的权威。
- `stop()` 立即发布 `idle` 并清除计时器。

`RuntimeProvider` 把展示状态写入 `lodyPresenceSyncStateAtom`；room-sync
registry 继续使用 `getSyncState()`/`subscribeSyncState()`，因此重连决策和
60 秒兜底仍会立刻看到故障。机器状态规则本身不变：`unknown` 仍不显示徽标，
只有确定的 `offline` 才可能阻塞工作。

## 备选方案

- **在徽标组件里做防抖。** 它要么在 transport 已死时无限期声称离线，要么在
  真正故障时仍然卸载；只有 transport 知道快照是否被保留。
- **把「未知」也显示成徽标。** 每次回收仍会改变该行，还引入侧栏不需要的
  第三种视觉状态。
- **把每次重连都当作 `synced` 直到失败。** 卡住的重连可能让离线声明持续
  数分钟；有界窗口把错误声明限制得更短。

## Effect 评估

本次修复没有在局部引入 Effect。`WorkspacePresenceTransport` 是面向
React、同步消费已发布 Streams SDK 的 Legacy 边界，没有 Effect 执行所有者
或 `Scope`，迁移路线也把渲染进程的 presence 留在 Legacy 一侧。局部使用
`Effect.sleep` 要么在类内调用 `Effect.runFork`，要么新增一个托管运行时回调
边界——这会产生无人拥有的 fiber 和一次不完整的迁移，而不是一个完整单元。
该宽限只是一个计时器，在每次状态转换时显式取消，并有假计时器测试覆盖。
等渲染进程 presence/transport 这个职责整体迁移时，宽限应改为 Scope 拥有的
fiber（`Effect.sleep` 加中断）并用 TestClock 覆盖；展示状态的契约不变。
按 feature/fix 的迁移规则，可以推迟，因为该单元无法脱离渲染进程 presence
边界独立完成。

## 证据与验证

对 `@loro-dev/streams-crdt` 0.19.2 的代码检查显示：读取循环正常结束和空闲
重试都会在保留 store 与 cursor 的情况下进入 `reconnecting`；
`setReadSubStatus` 会立即重算公开状态。症状来自桌面侧栏的实际反馈；没有
捕获渲染进程的同步状态轨迹，因此周期性触发是从该路径推断的，不是实测。
CLI `machine list` 在观察期间独立地把同一批机器报告为离线。

`packages/components/tests/workspace-presence-transport.test.ts` 的聚焦测试
覆盖：保留状态、窗口内恢复、窗口到期、终止状态、store 替换与停止。既有的
机器卡片测试继续覆盖 `offline`/`unknown` 的渲染。超过五秒的重连，或此路径
之外的新状态转换，仍可能闪烁；捕获渲染进程的 presence 同步转换仍是现场确认
触发原因的办法。
