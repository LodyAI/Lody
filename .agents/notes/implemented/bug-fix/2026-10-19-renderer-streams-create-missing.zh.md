# 渲染端负责创建由它的房间先到达的会话 stream

Status: implemented
Translation: current

[English](2026-10-19-renderer-streams-create-missing.md)

## 摘要

改用原生 Repo 和 Streams 之后，在渲染端新建的会话，第一条消息可能几分钟都没有
上传。它的 stream 预创建以 fire-and-forget 方式在另一个 SDK 实例上进行，所以
房间的首次 bootstrap 可能在 stream 存在之前就到达服务器。原生 transport 默认
不会创建缺失的 stream，而首次 bootstrap 遇到 404 会让 SDK 结束初始化，房间却
看起来仍在连接，于是在唤醒、网络或 token 事件之前没有任何东西去修复它。渲染端
transport 现在会在 join 时创建缺失的 stream，和 Legacy transport 一样。SDK
初始化已结束且不会重试的房间，现在也算作需要重连，由已有的重连循环按自身的
退避修复。这种检测是电平触发的，最长要等到循环 60 秒一次的兜底检查。

## 现象

用户在网页标签页里或为云端平面的机器新建会话。turn 已写入本地，agent 机器也
收到了执行请求，但会话文档房间始终没有就绪：第一条 turn 没有上传，发送路径的
上传屏障一直等待房间的首次同步。切换标签页的可见性、断网再联网、刷新 token 或
重新加载页面都能修复它。

## 原因

`lib/session-submission.ts` 里的 `startSession` 和 `createSession` 有意不等待
`runtime.ensureDocStream`：卡住的创建不能阻塞接收 turn。`ensureDocStream` 先
等待 transport，再通过 `createRemoteStreamLegacy` 创建 stream，后者会建立自己
的 SDK stream。房间的 join 运行在房间自己的 SDK stream 上，所以它的首次
bootstrap 可能抢先。在 Electron 中，`ensureDocStream` 对本地平面的会话文档直接
返回，所以这个竞争主要影响网页标签页和云端平面的会话文档。

[#1607](https://github.com/LodyAI/Lody/pull/1607) 把渲染端换成了原生
transport，它的 `createStreamIfMissing` 默认是 `false`；Legacy transport 默认是
`true`。在 `@loro-dev/streams-crdt` 0.19.0 中，首次 bootstrap 返回
`stream_not_found`（不可重试）会结束这一代的初始化：SDK 不再重试，写循环也不会
上传待发送的 turn。SDK health 报告 `ready: false` 和这个不可重试的错误，
`loro-repo` 把它投影为 `joining`，Legacy binding 投影为 `connecting`。

渲染端的房间 tracker 只标记断开或失败的房间。重连循环本来已经能通过
`WorkspaceRepoLegacy.reconnect` 和逐房间的 `syncOnce` 修复这种状态，却从未因此
被调度。只有强制触发才会执行这次修复。

[CLI 的修复](2026-10-18-cli-streams-create-missing.zh.md) 认为渲染端自己发起的
会话不受影响。由于这个竞争，这个说法是错误的。

## 决定

1. `createWorkspaceStreamsTransport` 设置 `createStreamIfMissing: true`，无论
   谁赢得竞争，房间的首次 join 都会建好 stream 并上传本地状态。它也和 CLI 一样
   设置 Code Collab file-index 的 TTL：渲染端会 join 这些 Flock 房间，如果它在
   没有 TTL 的情况下建好 stream，后来的创建者会发现 stream 已存在，这个 stream
   就会永久保留。
2. `WorkspaceRoomBinding.initializationFailed` 读取 SDK health，使用的判断条件和
   `reconnect` 修复 joining 房间时相同：未就绪、没有待完成的释放，并且错误不可
   重试或触发了初始同步硬截止时间。房间 tracker 把带有这一证据的 connecting 或
   reconnecting 房间算作需要重连。本地和云端重连循环会在下一次 update 时修复它，
   使用已有的指数退避（从 1 秒翻倍到 30 秒），并且只在持续健康一段时间后才重置
   退避。

渲染端 transport 的使用者是它的 Meta 房间、会话及其他文档房间，以及具名 Flock
房间（工作区目录、机器行、定时任务、agent 和 Code Collab file index）。#1607
之前，它们都会创建缺失的 stream，但不带 file-index TTL。Prompt shortcuts 使用
自己的 transport，仍然只在写入时创建。受保护内容的创建使用和显式预创建相同的
SDK 创建请求头。

否决的替代方案：

- **在接收 turn 之前等待预创建。** 卡住的创建会阻塞历史和派发写入，这正是它被
  设计成 fire-and-forget 的原因。
- **在 Legacy binding 中把初始化失败投影为 `error`。** 这样状态本身就带有变化
  事件，但 CLI 共用这个投影和读取它的首次同步等待者，而 CLI 的恢复对这种状态有
  自己的规则。
- **在探测结果变化时重新发出状态。** 这会给所有 binding 监听者发送重复的状态，
  包括 CLI 的监听者。第一部分已经让这种情况很少出现，作为兜底，电平触发的定时
  检查就足够了。
- **在 tracker 里加重试计时器。** 这会重复循环的退避和健康持续期重置。

取舍：渲染端 join 一个在远端被删除的 stream 时会重建一个空 stream，CLI 和
#1607 之前的渲染端也是这样。被服务器永久拒绝的房间（例如授权失败）在页面打开
期间，最多每 30 秒进行一次逐房间同步，再加上每次持久化修复本来就会执行的空闲
store 释放。之前它会一直卡住，没有任何重试。

## 故障隔离

触发条件是首次 bootstrap 遇到的任何不可重试失败，或两分钟的初始同步硬截止时间。
恢复仍由已有的重连循环和逐房间同步负责；没有调用方会因为新的探测而等待、拒绝或
加锁。之前的行为是房间一直卡住，直到出现强制事件。修复只会重启该房间的 SDK
generation：有待完成释放的 joining 房间仍交给 SDK 处理。修复失败时探测结果保持
为 true，房间仍被标记，这次尝试计为一次退避。

## 证据

- `packages/components/tests/workspace-streams-transport.test.ts` 让真实的渲染端
  transport 和 Repo 对接一个字节级服务器，该服务器在收到 stream 级 PUT 之前一律
  返回 404。会话文档 join 时会建好 stream，并上传 join 之后立刻写入的 turn；
  file-index Flock join 时会带着 TTL 建好 stream。使用旧的 transport 时这两个
  测试都会失败：上传屏障以 `Repository adapter operation failed` 拒绝。
- 同一个测试文件中，首次 bootstrap 返回不可重试的 400 时，binding 保持
  `connecting` 且 `initializationFailed` 为 true，`WorkspaceRepoLegacy.reconnect`
  会修复它并上传之前的写入。进行中的 bootstrap，以及 SDK 会重试的 503，都让探测
  结果保持 false。
- `room-sync-tracker.test.ts` 和 `local-reconnect-loop.test.ts` 表明 tracker
  会标记该房间，循环在兜底检查时修复它，等待 1 秒和 2 秒，不需要外部触发。修改
  之前，tracker 报告不需要重连，循环也没有任何尝试。

未验证：在真实浏览器中对接生产 Streams 服务时的竞争情况。
