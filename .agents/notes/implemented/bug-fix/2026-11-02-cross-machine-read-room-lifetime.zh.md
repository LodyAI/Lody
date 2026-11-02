# 跨机器读取不得长期持有 room，也不得拖垮整条 transport

Status: implemented
Translation: current
Issue: [#2194](https://github.com/LodyAI/Lody/issues/2194)

[English](2026-11-02-cross-machine-read-room-lifetime.md)

## 摘要

Daemon 上的 MCP 读取如果涉及其他 Machine 的数据（不带 Machine 过滤的
`lody_agent_role_list`、`lody_session_list`、`lody_session_status_many`、
`lody_session_history`），会 join 那台 Machine 的 Flock 或 Session room，并一直保持到进程结束。
如果这个 room 的首次同步始终完不成，每次 120 s 的 `initial_sync_timeout` 都会让 Streams
聚合状态变成 `disconnected`。恢复逻辑随即重连整个工作区、重新 join 这个 room、重扫当前 Machine 的会话，
并跳过云端副作用。这个循环大约每 121 s 重复一次，直到重启。修复限制了这类读取持有 room 的时长，
并且不再把单个失败的 room 当作 transport 断线。

## 机制

- Catalog reader 会永久持有每个被请求的 Flock：`held` 没有删除路径，reader 停在
  `Effect.never`，失败后无限重试。
- MCP 读取会话使用 `getOrCreateSessionDoc`。它会把 doc 放进共享且没有引用计数的
  `sessions` 缓存，而其他 Machine 的会话不会被任何逻辑清出缓存。
- `loro-repo@0.25.0` 中，只要任一 room 处于 error，聚合状态就是 `disconnected`。
  `connection-recovery.ts` 把这视为不健康：重连整个工作区、执行 meta-ready 流程，并让
  `isTransportConnected()` 返回 false。
- `streams-crdt@0.19.2` 中 `initial_sync_timeout` 可重试。失败的 join state 不会被释放，
  `repo.reconnect()` 会通过 `rejoin()` 重新启动它。

0.108.x 已有同样的代码；跨机器 Role 和跨机器读取变多后，触发才变得常见。0.109.0 新增的
Streams 补丁只在启用 payload protection 时生效，解释不了 plaintext 工作区的报告。

## 决策

1. **健康状态以 meta room 为准。** meta room 处于 joined 时，聚合 `disconnected` 报告为
   `rooms-degraded`，在恢复逻辑中视为健康：只清扫失败的 room，失败后约 1 s 开始，持续失败时退避到 30 s，
   因此当前 Machine 自己的 room 恢复速度与之前相同；不触发 transport 级重连、恢复边沿或 O(rooms) 重扫。控制云端副作用的
   `isTransportConnected()` 在 meta room joined 时返回 true。即使其他 room 让聚合状态变成
   disconnected，`waitUntilMetaSynced` 也照常等待 meta room。adapter 关闭和真实断网都会让
   meta room 一起下线，因此仍走完整的恢复路径。
2. **Catalog 租约改为临时。** metadata 和工作区 Flock 保持 joined。其他 catalog reader 在最后一次
   `hold`/`ready` 调用后 `TRANSIENT_CATALOG_IDLE_MS`（5 分钟）释放。闲置的 reader 不再等待
   baseline，也不再重试。释放出现 defect 时会在关闭时报告，
   但不会被缓存：下一次读取会启动新的 reader。
3. **读取其他 Machine 的会话改为临时读。** `readSessionDocTransiently` 对已缓存或正在初始化的
   doc 直接读取；否则在该 doc 的本地所有权链下，于 `sessions` 之外打开一个临时
   `SessionDocument`，读完以保留状态的方式销毁。云端 room 在该 wrapper 之外 join。
   history 最多等待 8 s 完成首次同步，但如果之前读取保留的 room 仍在等待，就不再重复等待；list 和 status 不等待。随后 room 会保留到首次同步完成，
   或经过 `TRANSIENT_DOC_ROOM_RETAIN_MS`（150 s，长于 Streams 的 120 s 期限）为止。如果读完立即释放，
   每次较慢的首次同步都会被中止：大型对话记录永远到不了本地副本，已结束的 turn 也会一直显示忙碌。
   保留的 room 与 renderer bridge 共用登记表，因此正式的 `getOrCreateSessionDoc`、renderer 离开以及
   manager 清理都会取消它。临时 wrapper 清理失败只记录日志，绝不替换已完成的读取结果。
   本地 renderer room 或保留中的 room 仍在使用该 doc 时，不会卸载它。当前 Machine 自己的会话继续使用
   缓存中的执行 doc。

## 备选方案

- **只采用 [loro-streams#440](https://github.com/loro-dev/loro-streams/pull/440)**
  （240 s 超时、超时不可重试）。这只会拉长每轮周期，并改变由谁发起重试。catalog 重试仍会重新
  join，每次失败仍会让聚合状态变成 disconnected，整台 Machine 的影响依旧存在。该 PR 发布后仍值得采用。
- **在 loro-repo 中修改聚合逻辑。** 这是逐 room 状态的长期正确归属，但需要发布 SDK。Lody 侧的
  健康规则不依赖它；即使 SDK 以后单独报告逐 room 失败，这条规则依然正确。
- **MCP 读完后销毁缓存的会话 doc。** 否决：`sessions` 没有引用计数，销毁其他持有方已经接管的
  doc 会破坏那个持有方（见 `apps/cli/src/lib/loro/AGENTS.md`）。
- **保留原恢复逻辑，只加重连退避。** 这种退避已经存在（`tests/reconnect-storm-repro.test.ts`）。
  它能限制重连频率，但整个故障期间仍把当前 Machine 标为离线、跳过云端副作用。

## 权衡

- 闲置 5 分钟后，第一次 catalog 读取会重新返回 `catalog_syncing`，直到新 reader 达到 baseline。
- 其他 Machine 会话的 list 和 status 按本地副本现状作答，保留的 room 会为下一次读取刷新副本；
  活跃状态仍来自 presence 和所属 Machine 的 RPC 快照。
- 始终无法同步的 room 会在之后每次读取时重新 join，并在 150 s 后释放；它的失败只表现为
  `rooms-degraded`，不影响整台 Machine。
- 为什么某些 room 从另一台机器始终完不成首次同步（服务端、代理或 room 数据），本次不处理。

## 验证

- `apps/cli/src/lib/loro/connection-recovery.test.ts` 覆盖 meta room joined 时某个 doc room
  失败的情况：约 1 s 后只清扫该 room 并逐步退避，云端副作用和 meta 等待照常可用；也覆盖没有
  meta room 时 transport disconnected 的情况。
- `apps/cli/tests/reconnect-storm-repro.test.ts` 场景 A 和 D：meta room joined 时聚合状态反复
  抖动，fan-out 和重扫均为零。场景 B：真实断网仍按退避重试。
- `apps/cli/src/lib/loro/workspace-catalog-sync.test.ts` 覆盖其他 Machine 的 catalog 始终不同步
  的情况：闲置窗口后释放，读取会延长租约，没有读取时不重新 join，之后可以再次 join。
- `apps/cli/src/mcp/daemon-session-tools.test.ts` 覆盖其他 Machine 的会话：status 会保留 room
  直到首次同步后释放；首次同步卡住时 history 用本地副本作答，该 room 保留期间不再重复等待，并在上限时释放；之后的读取会重新
  join；临时 wrapper 清理失败时保留已完成的读取结果。
- 未在真实 Streams 和卡住的 room 上验证。保留 room 时保护 renderer 和取消的分支只经过代码审查，没有测试覆盖。
