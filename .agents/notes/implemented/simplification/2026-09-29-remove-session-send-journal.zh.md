# 移除会话发送日志

Status: implemented
Translation: current

[English](2026-09-29-remove-session-send-journal.md)

## 摘要

渲染进程曾把每条已接受的消息保存在可跨崩溃恢复的 IndexedDB 发送日志中，直到目标
收到为止。这种持久化要求波及发送路径、归档、删除、登出、清缓存、所有窗口以及
Electron 退出，每次修复都会暴露新的边界问题。现在移除发送日志。就绪的消息作为
本地提交写入实时文档，随后尽力发出 dispatch 或 steer 请求；CLI 本来就会从已同步
的历史启动待处理消息。附件仍在准备的消息只在渲染进程内存中按会话顺序等待，全部
附件就绪后才写入。接受的代价是：上传期间页面关闭、崩溃、重新加载或切换工作区，
这条消息就会丢失，唯一的保护是离开确认。

## 问题

发送日志（`lody-session-send-v1`，记录版本 1–4，阶段
`saved → prepared → committed → delivered`）来自 #719（提交
`cf5c925b..c5a07dd0`），后续修复包括 `5aa38149`、`39e74acb`、`a4dfbf6f`、
`21993521`（#1079）、`e89ab564`（#1091）、`1e805cf7`（#1095）和 `e7e7ae1b`
（#1104）。为了让输入在崩溃后仍然存在，它引入了：

- 持久化源 Blob；
- 跨窗口 Web Locks 与 BroadcastChannel 中断；
- 核对身份前合并原窗口的副本；
- guide 投递记录，保证结果未知的 steer 不会重放；
- 投影覆盖层，避免纯文本发送闪现为待发送；
- 拦截登出、清缓存、重新加载和切换工作区；
- Electron 主进程与渲染进程之间的退出/关闭/重新加载握手。

这些机制各有失败方式（仅 #1104 就重做了归档和退出拦截）。而持久化真正保护的，
只是从点击发送到附件上传结束之间的这一小段时间。

## 决策

移除可跨崩溃恢复的发送日志。附件仍在准备时，把发送保存在内存中。接受上传期间
关闭页面会丢失消息。

- **就绪发送**（`lib/session-send-delivery.ts`、`session-send-admission.ts`、
  `session-submission.ts`）：`writeUserTurn` 经 WorkspaceWriter / SessionData
  写入本地提交。先写新会话元数据（只写缺失的键），再写消息
  （`appendSessionTurn`）或队列行（`enqueueSessionMessage`，同时更新
  `messageQueueUpdatedAt`）。dispatch 还会写 `latestUserMsgId`：它不会退回到更新
  的本地用户消息之前，归档或已删除的会话则跳过。最后执行 `repo.flush()`。之后
  dispatch RPC 作为快速路径运行，失败只记录日志。RPC 已被接受后指针写入失败，
  发送仍视为成功。没有重试循环，也不等待目标同步。
- **Guide / steer**：消息先以 `pending_apply` 写入本地，然后发出请求。
  - `applied` → 标记为 `processing` 并记录 steer 已投递。
  - 没有 `recoveryOwned` 的 `no-active-turn` 或 `promotion-failed` → 消息改为
    `pending`，写入执行指针并 dispatch。
  - `recoveryOwned` → 不做任何事，由 daemon 负责。
  - 结果未知（`delivery-unknown`、超时、传输错误）→ 保持写入时的状态，绝不
    重放，也不显示为发送失败。
  - 请求确定无法发出时（目标走云端且浏览器离线，`isMachineRpcUnreachable`），
    消息改为 `pending` 并写入执行指针。
  - 原生队列 steer 恢复发送日志之前的顺序：用队列项的 `userTurnId` 写入
    `pending_apply` 历史，删除队列行，再发 steer。
- **暂存发送**（`lib/session-pending-sends.ts`、
  `providers/workspace-pending-sends.ts`）：有未就绪附件的发送按工作区运行时
  暂存，复用现有的附件准备、资源管理和分片上传取消。所有附件就绪前不写入 CRDT。
  失败时发送连同错误保留在内存中，提供重试和取消。每个会话先进先出：同一会话之后
  的历史、队列或 guide 发送都排在更早的暂存发送之后；队首失败会阻塞后续发送，
  直到重试或取消。取消暂存的首条消息时，会把新会话元数据交给下一条暂存发送。
- **展示**：暂存的新会话通过 `pendingSendSessionMetasAtom` 显示。暂存发送在会话
  中显示为内联待发送行；走队列时显示为队列面板中的本地行。侧边栏标记来自同一个
  内存存储（`components/chat/session-pending-sends-host.tsx`）。
- **离开**：存在暂存发送时，页面安装 `beforeunload`。Electron 中，
  `apps/electron/src/main/renderer-unload.ts` 把渲染进程的任何否决转为一个原生
  “留下/离开”确认，覆盖关闭、重新加载和退出。退出时先逐个关闭产品窗口并取得离开
  许可，然后才停止 relay 和 CLI；选择“留下”会取消退出，一切保持运行。关闭期间渲染进程卡死或崩溃的窗口会被直接销毁，退出不会无限等待。同一个确认
  也覆盖 code-collab 未保存编辑器的保护。
- **归档/删除**不会因待发送消息而拒绝。它们取消目标会话的暂存发送（包括
  `parentSessionId` 指向目标的暂存子会话创建），并等待正在进行的写入结束，保证
  已取消的发送之后不会再写入。归档只以暂存创建形式存在的会话，只会取消它。
- **登出、清缓存、重新加载和切换工作区**不再受拦截。清缓存会删除
  `lody-session-send-v1`；仍会读取旧版本写入的强制清除标记。

## 职责

| 关注点                 | 负责方                                               |
| ---------------------- | ---------------------------------------------------- |
| 本地接受边界           | 经 WorkspaceWriter / SessionData 的 `writeUserTurn`  |
| 执行待处理的用户消息   | CLI dispatch watcher，读取已同步的历史和元数据       |
| RPC dispatch/steer     | 尽力加速（`dispatchUserTurn`、`steerUserTurn`）      |
| 等待附件的发送         | 运行时 `pendingSends`，仅在内存中                    |
| 上传、取消、store 借用 | 现有工作区 `sendResources`（Effect）                 |
| 离开保护               | 页面中的 `beforeunload`；Electron 主进程中的原生确认 |

## 证据

CLI 从已同步数据 dispatch（`apps/cli/src/session/session-dispatch-logic.ts`）：

- `shouldWatchSession` 监听元数据中的执行信号 `latestUserMsgId`、
  `hasPendingUserTurnActivation` 和 `messageQueueUpdatedAt`。
- `findNextDispatchableUserTurn` 不经 RPC 就会 dispatch `pending`/`seen` 的用户
  消息，并跳过已归档会话。
- `pending_apply` 的 guide 消息只有在 `steerTurnStatuses[id] === 'pending'` 或
  `latestUserMsgId` 指向它时才会被 dispatch。

因此本地写入的消息加上执行指针，在文档同步后就足以执行。发送日志的 `delivered`
阶段保护的是 daemon 不依赖它也能达到的结果。两项不依赖发送日志的修复继续保留：
#1079 在 `LocalLoroTransportAdapter.syncDoc` 中的强制 flush，以及 #1091 的判定
`isSessionHistoryStatusAwaitingStart`（`seen` 仍视为等待开始）。

## 备选方案

- **保留发送日志和发件箱，继续修补边界。** 放弃：所有可能结束页面的入口都必须
  了解它，而修补一直在移动边界。
- **只为带附件的发送保留 IndexedDB 发件箱。** 放弃：仍要保留 Blob 持久化、跨窗口
  归属和恢复界面这些主要复杂度，只为保护中断的上传。
- **只在内存中暂存。** 采用：就绪发送在 CRDT 之外不需要额外持久化；上传被中断时，
  用户在离开前就能看到。

## 取舍

采用的方案下，页面关闭、崩溃或重新加载，或工作区运行时被销毁（例如切换工作区）
时，暂存发送会丢失。桌面端关闭、重新加载和退出会先确认；切换工作区会销毁运行时
并直接取消暂存上传，不会询问。发送日志中上传后的计费资格复查已删除，输入框在
发送时仍会检查。dispatch RPC 失败不会自动重试，CLI watcher 会从已同步历史中接手。

## 旧数据迁移

`lib/legacy-session-send-migration.ts` 在每个运行时首次元数据同步后运行一次，
受 `navigator.locks` 保护，只读取当前账号和工作区：

- 消息不存在的遗留记录作为普通本地发送写入。version 2 的 `committed` 记录绝不
  重新追加，因为新副本可能只是尚未同步到它们。
- dispatch 记录和从未发出的 guide 尽力写入执行指针并 dispatch；
  `guideOffer: 'offered'` 的 guide 保持不动。
- 含未就绪附件的记录通过 `console.warn` 提示后丢弃。
- 处理完的记录会删除，失败的记录在下次启动时重试，数据库清空后删除。

本变更发布几个版本后，删除该迁移以及对强制清除标记的读取。

## 验证

`packages/components/tests/` 下的行为测试覆盖本变更，包括
`legacy-session-send-migration.test.ts`、`session-pending-sends-host.test.tsx`、
`use-session-actions.test.ts`、`session-attachment-preparation.test.ts`、
`session-pending-message-row.test.tsx`、`clear-local-cache.test.ts`、
`runtime-provider.test.tsx` 和 `warm-window-lifecycle.test.ts`。发送日志、恢复与
投影相关测试随代码一并删除。命令与结果：见 PR。

## 限制

- 附件完成前页面关闭、崩溃、重新加载或工作区运行时被销毁，暂存发送会丢失。
  浏览器可能不显示 `beforeunload` 提示（移动端尤其如此），切换工作区也不会询问。
- 未执行打包设备或原生移动端验收。
- 旧数据迁移只能重放旧版本保存的内容，上传未完成的记录会被丢弃。

本决策替代[本地优先发送](2026-09-29-local-first-session-send.zh.md)、
[延迟附件方案](../architecture/2026-09-14-deferred-attachment-send.zh.md)中与发送
日志相关的部分，以及[daemon 接手的 guide 结果](../bug-fix/2026-09-28-daemon-owned-guide-outcome.zh.md)；
部分替代[队列本地行](../feature/2026-09-28-local-queue-pending-rows.zh.md)和
[侧边栏发送状态](../feature/2026-09-28-sidebar-send-status.zh.md)。Spec：
[Session files](../../../../specs/session-files.zh.md)。
