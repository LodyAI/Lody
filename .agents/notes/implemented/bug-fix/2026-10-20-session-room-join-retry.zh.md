# 初次加入全部失败后，会话房间会重新加入

Status: implemented
Type: bug-fix
Translation: current
PR: [#1760](https://github.com/LodyAI/Lody/pull/1760)

[English](2026-10-20-session-room-join-retry.md)

## 摘要

一个打开着的对话，如果它的会话房间在最初三次加入中都没能 attach（三次加起来约 3 秒），之后只要对话还开着就不会再试。
界面一直停在缓存内容上，直到刷新。Loro Repo 会拆掉所有传输都 attach 失败的房间记录，
因此 `repo.reconnect()` 和 workspace 重连循环都没有东西可修。现在，只要还有同步 lease
持有这个房间，会话 store 就按共用的 1–30 秒重连退避重新加入。房间同步 tracker 也会
采用新订阅的当前状态，重试成功后才能报告 `synced`。"同步到一半停住、刷新才好"
另有一个更可能的原因：live read 的应用链卡住，但房间仍是 `joined`。本文在下面分析了它，
但这次没有修；作为替代，对话的 history 一直停在一个 live presence 显示已不在运行的 turn 上时，
现在会记录一条有界的 `session.doc_stale` 诊断。

## 原因

`create-workspace-runtime.ts` 里的 `startSync` 调用 `waitForRoomToSync`，后者只在
`joinRoom()` 抛错时重试：0、+1 秒、+2 秒。这不是超时：`joinRoom()` 一旦返回订阅，
首次同步会一直等，之后即使 reject，订阅也会保留并自愈。三次都抛错时，Loro Repo 0.23.3
的 `joinRoom` 已经释放了这个房间（`releaseRoomRef` → `teardownRoom`）。store 记录
`markFirstSyncFailed()` 并清空 join promise。之后没有任何地方再调用 `startSync`，因为
`acquireSync` 每个挂载的视图只调用一次（`use-session-doc.ts`）。tracker 报告 `error`，
重连循环于是按退避调用 `repo.reconnect()`，但它只修复仍然存在的房间。

这条路径的可达性有限。网络和鉴权故障不会让 `joinRoom()` 抛错：Streams 和本地数据面两种
adapter 的 connect 都不做 I/O，`joinDocRoom` 同步返回订阅，之后由 SDK 自愈；已打开的会话
store 的 doc 也已加载，`ensureDoc` 直接命中缓存。已知的抛错来源只有同步的 adapter join 异常
和加载时的存储失败。因此这次重试是防御性修复，不是常见的"不再更新、刷新才好"的原因。

## 决定

- 一轮 join 没有产生订阅就失败，且仍有 lease 时，store 在
  `computeLocalReconnectDelayMs(attempt)` 之后重新加入。成功加入后重置计数。释放最后一个
  lease 或销毁 store 会取消定时器；最后一个 lease 释放后才触发的定时器什么都不做，
  房间仍由待执行的释放流程负责。
- 退避期间有调用方要求同步时（新的 lease，或者发送、发送中指示、完成通知里的
  `waitUntilSynced`），会取消定时器并立即 join，保留尝试次数。否则这次等待会在完全没有
  join 的情况下 resolve，消息的"发送中"状态被清掉而实际什么都没上传，故障解除后的恢复
  也要再等最多 30 秒。并发调用仍共用同一轮 join。
- `createRoomSyncTracker().attach` 现在立即应用 `sub.status`。Loro Repo 的 binding 在
  base attach 时就发出状态，早于 `joinRoom()` resolve 并把它交给 tracker。不这样做，
  失败那轮写入的 `error` 会比替换它的订阅活得更久。

另一个方案是让 workspace 重连循环重新执行会话 join。但它拿不到 store 自己的 join 状态，
而且每一轮都会释放空闲 store、为其他房间重置退避。store 内部的定时器把重试限定在这一个
房间和它的 lease 生命周期内。

## 验证

`create-workspace-runtime-meta-recovery.test.ts` 新增三个用例，使用真实 `LoroRepo`，
其本地 adapter 在 `joinDocRoom` 中抛错。第一个让前四次 join 失败，然后断言 store 达到
`synced` 并 resolve `firstSynced`；两处修改之前它都会失败（先是不重试，后是残留的
`error`）。第二个让前三次失败，然后断言一次 `waitUntilSynced` 调用在 100 毫秒内完成 join
（远小于最短退避），且被取消的定时器之后不会再多 join 一次；定时器挡住调用方时它会失败。
第三个断言释放 lease 后不再 join。相关组件测试套件全部通过。

## 未解决：live read 停止应用，但仍保持 joined

用户报告的现象不同：对话本来在同步，后来不再更新。发出的消息都进入队列，因为过期的
history 停在一个没结束的 assistant turn 上（`unfinished_assistant_turn` 路由），info bar
也没有任何提示。读 streams-crdt 0.19.1 的代码能找到一条同时符合这三点的路径，但还没复现：

- 每批 SSE 数据在被应用之前就会重置 45 秒无活动看门狗，然后在房间唯一的 `opQueue`
  （`enqueueExclusive`）上应用。应用会先导入更新，再在 Loro Repo 的持久化屏障之后保存
  cursor（`persistDocNow` → 整个 Repo 共用的 DocManager 队列 → 一次 IndexedDB 事务）。
  这些步骤都没有超时。
- 其中一步挂住时，后续批次和本端上传（`flushPendingLocal`）都排在它后面，而持续到达的
  事件让看门狗一直不触发。房间保持 `ok`/`joined`，tracker 报告 `synced`；"caught up"
  每次打开后是 sticky 的，所以不会出现提示。刷新会重建整套栈，从服务端重新 bootstrap。
- 服务端如果只发 keepalive，从客户端看完全一样。

真正的修复（给应用链加 deadline，看门狗按应用进度而不是按事件到达计时）属于 loro-streams
和 Loro Repo。

## 卡顿诊断

此前没有任何东西记录这类现场。Loro Repo 的 binding 不暴露 SDK 的 `pendingLocalCount`；
持久化的 client log（随 bug report 上传：有机器的报告带完整日志，否则带尾部）只记录显式的
`recordClientLog` 调用；刷新会丢掉 console 的 `info` 和 SSE 帧。桌面端渲染进程的
`warn`/`error` console 会经 Electron main 写进 CLI 每日日志。

`useSessionDocStaleReport`（由对话界面挂载）在以下条件同时持续 30 秒时触发：doc 已就绪、
所属机器心跳新鲜、presence 显示没有在运行，而 history 仍停在一个未完成的 assistant turn。
机器状态为 unknown 或 offline 时不触发，因为 agent 死掉也会留下未完成的 turn。每个 turn
在每次挂载的对话里只记一次，写成 `warn` 级 client log 和 console 警告，只含 id、状态和时长：

- readiness binding 的 `bindingStatus`、`syncState` 和 `transportId`；
- `lastRemoteImportAgoMs`，来自每个 store 记录的 import 时间戳（`null` 表示 store 打开后
  没有远端 import），对照来自 Session meta 的 `lastMessageAgoMs`，后者经独立的 Meta 流到达；
- `pendingUploadProbe`：一次限时 10 秒的 `waitFor({ phase: 'pending-upload-empty' })`。在
  streams-crdt 0.19.1 里它先 flush 本地导出，然后只等本副本排队中的上传清空，不进入房间的
  `opQueue`。没有待上传内容时它立即返回 `complete`，所以永远不能证明入站应用在正常进行。
  `timeout` 表示本地改动 10 秒内没传出去：可能是队列卡住，也可能只是上传慢。

解读：主要信号是 binding 为 `joined`，但远端 import 很旧而 meta 消息很新——房间自称正常
却已停止应用，是单个房间卡住。probe 再是 `timeout`，说明本副本的上传也卡住了，与房间队列
卡住一致。binding 不是 `joined`，是普通的传输问题。同一 workspace 的其他
对话也一起停了，指向整个 Repo 共用的持久化队列。误报来自机器仍在线但 agent 已死的 turn：
每个 turn 最多一条。两个测试都没有覆盖真实卡住的 SDK；它们覆盖触发条件、记录字段，以及
针对永不 settle 的 `waitUntilSynced` 的探测。
