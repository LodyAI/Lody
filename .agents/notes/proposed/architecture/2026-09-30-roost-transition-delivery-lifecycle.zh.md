# Roost 接入前的 Loro 优先对话投递生命周期边界

Status: proposed
Type: architecture
Translation: current

[English](2026-09-30-roost-transition-delivery-lifecycle.md)

## 摘要

Lody 目前把 queue 提升、steer 和 ACP 输出处理直接绑定在 Loro 历史与会话本地生命周期上；在新会话改用 Roost、旧会话继续使用 Loro 之前，必须先把这条耦合边界显式化。本提案建立由 Lody 持有的 session backend 边界，并先把 queue promotion、steer reconcile、历史读取和主要 assistant 写入迁移到现有 Loro 路径。未来的 Roost backend 实现同一组契约而不改变 queue 或 steer 状态机；独立的 steer 持久 operation ledger 和 Roost 跨存储投影仍是后续工作。

## 决策与范围

眼下的目标是建立内部过渡边界，而不是迁移存储。已有会话继续使用 Loro。在 Roost 正式启用之前，新建会话也继续使用 Loro；启用之后，backend 在会话创建时一次性选择：新会话使用 Roost，已有会话继续使用 Loro。之后所有历史、queue、steer 和 assistant 输出操作都通过会话保存的选择解析 backend，调用方不再分别判断 Roost 或 Loro。

过渡必须保持现在的产品契约：

- queue 消息只处理一次，即使 promotion 被重试，或者在多个副本上被观察到。
- steer 要么应用到指定的运行中 turn，要么在明确证明无法投递时转成普通后续 turn，要么保留为明确的未知或终态；投递未知时绝不能静默重放。
- 流式 assistant 输出、usage、permission、附件和 tool item 始终绑定到产生它们的逻辑 assistant 消息，包括 finalization 期间到达的输出。
- 编辑并重新发送已有消息时创建 replacement active branch，同时保留旧 sealed branch。这是唯一有意替换逻辑 turn 的操作；晚到 ACP 事件不能创建 fork。
- UI 继续消费现有的 `SessionHistoryInput` 形状和状态词汇。backend 选择、Roost 物理 segment、恢复记录和 operation identifier 都是内部细节。

本提案不迁移旧 Loro 历史、不修改 Loro 上游库、不修改 Roost Rust core，也不引入第二种用户可见的会话模型。范围覆盖 Lody CLI/session execution 路径及其客户端使用的共享会话 API。平台客户端使用同一组契约，不各自实现 queue 或 steer 协议。

## 四个过渡边界

### `HistoryEngine`

`HistoryEngine` 负责逻辑会话操作：创建和读取 user turn，开始和结束 assistant target，应用 user status，执行 Edit & Resend，并提供 dispatch watcher 和 UI 消费的投影历史。它不向调用方暴露 Loro container 或 Roost segment。

Loro 实现委托给 `SessionDocument`、`HistoryWriter`、现有 activation metadata 和历史 reader，同时保留现有的 last-copy identity lookup 以及 replacement-turn 行为。Roost 实现会追加或 seal Roost 记录，并通过 adapter 的 projection 返回相同的逻辑历史。操作结果包含稳定的逻辑标识与幂等结果，例如 `applied`、`already-applied`、`not-ready` 或 `conflict`，不暴露存储特有的 cursor。

### `DeliveryLedger`

`DeliveryLedger` 负责 queue 与 steer 的持久 intent 和投递状态。每个 user input 都有稳定的 `userTurnId`，每次 mutation 都有 `operationId`。重试使用相同标识，因此 backend 会完成或报告同一个操作，而不是再次追加一个 turn。

账本与 provider 投递是有意分开的。历史写入只能证明逻辑 turn 存在，不能证明 ACP steer 已经到达 provider。provider 结果仍然是 `applied`、`not-applied` 或 `unknown`；用户可见的 disposition 继续由这些结果与历史证据共同推导。

### `AssistantTargetResolver`

`AssistantTargetResolver` 把 ACP run 绑定到拥有其输出的逻辑 assistant entry。绑定在 run 开始时捕获，并随每个 buffered notification 一起携带。flush 代码不能在 flush 时读取“当前 active 的 turn”来重新决定旧事件的 target。这是防止旧 run 的尾部输出写入新 user turn 的关键边界。

解析器还负责 finalization 尾部：`finish-assistant` 之后 target 仍然可寻址，使晚到输出、usage、permission 结果、附件和 tool event 继续写入同一逻辑 assistant 消息。只有新 turn 自己初始化 run 后，后续 turn 才能接管输出所有权。

### `HistoryProjection`

`HistoryProjection` 把 backend 记录转换为现有逻辑历史模型。Loro 可以直接从可变 assistant entry 投影；Roost 可能有一个 sealed primary segment 以及多个晚到输出 segment，因此它按 `businessId` 分组，并按与 Loro 相同的顺序返回一个逻辑 assistant entry。投影是 adapter 的职责，调用方不能检查物理 segment ID。

投影必须增量化。读取可见窗口时，不能因为一个 assistant segment 改变就重新构建整个长对话。adapter 可以缓存 `businessId` 到逻辑 entry 的分组关系，只使受影响的逻辑 entry 失效。

## Backend 选择与所有权

会话记录在创建时保存 backend discriminator。没有该字段的旧会话按 `loro` 解释。Lody 会把一个 backend 对象绑定到每个已打开的 `SessionDocument`，同一文档的所有调用都拿到这个对象。进程重启后会重新读取持久 discriminator 并创建新的内存对象；已打开文档的 backend 类型发生变化时直接 fail closed。

选择规则如下：

| 会话                         | Roost 上线前     | Roost 上线后                                           |
| ---------------------------- | ---------------- | ------------------------------------------------------ |
| 已有 Loro 会话               | Loro             | Loro                                                   |
| 新建会话                     | Loro             | Roost                                                  |
| backend 初始化失败时的新会话 | 不创建半成品会话 | 不静默切换为混合 backend；创建操作返回普通失败，可重试 |

不存在单条消息从 Roost fallback 到 Loro 的路径。那会把同一个逻辑会话拆到两个历史中，使 queue、steer 和晚到输出的恢复无法判定。未来若需要迁移 backend，应当另行定义显式 snapshot 和校验协议。

## Queue promotion

### 必须保留的现有行为

dispatch watcher 按以下顺序检查 turn 来源：本地 history、持久 message queue、RPC stash。queue promotion 由现有 rewrite-conflict lease 串行化，dispatch check 按 session 合并。watcher 已经保护重复 copy、已结算 turn、被拒绝的 steer 以及缺失 activation pointer；这些是产品规则，不是 Loro 专属细节。

### Loro 优先实现

Loro backend 暴露一个逻辑操作 `promoteQueuedTurn`。输入包含 queue row 标识、稳定的 `userTurnId`、`operationId` 和规范化后的 turn payload。watcher 会传入自己已经读取的 history copy；直接调用 backend 时最多对指定 turn 做一次 `readTurn`，不会再次物化整个 history。现有 rewrite-conflict lease 负责与 Edit & Resend 串行化，操作围绕可恢复 receipt 推进这些写入：

1. 记录 `prepared`；在不存在精确 copy 时追加 user turn，然后记录 `history_accepted`。
2. 发布 activation pointer，然后记录 `activation_published`。
3. 删除精确 queue row，然后记录 `queue_consumed`。
4. 返回 dispatch 应执行的逻辑 turn。settled/refused steer 的判断仍在 watcher 中，因为它依赖 execution-owned evidence。

操作必须幂等。完成某个阶段后重复相同 `operationId` 只返回已记录的逻辑 turn，不再次追加 history。任何单次写入失败后的重试只读取账本和指定 turn，完成缺失阶段。启动恢复会扫描未完成 receipt，保留 queue 顺序与编辑 lease；如果 queue row 已经消失但 user turn 已接受，则只修复 activation 并关闭 receipt。旧 queue row 没有 `operationId` 时使用兼容标识 `queue:${$cid}`；新写入持久化稳定标识。

Loro command 必须保留现有 last-copy-wins lookup，不为了简化 promotion 删除历史 duplicate copy。no-op status write、settled terminal status、active execution owner 或已有 activation pointer 都可以独立证明 queue row 不再需要 promotion。

### 未来 Roost 实现

Roost 不能假设一次事务同时覆盖 Roost history、Loro control-plane activation pointer 和 queue row。因此 Roost adapter 使用相同的 `operationId`，并在 delivery ledger 中推进可恢复的操作状态。持久阶段为 `prepared`、`history-accepted`、`activation-published` 和 `queue-consumed`；终态结果为 `applied` 或 `already-applied`。

正常 dispatch 前先扫描未完成操作。如果 history 已接受但 activation 尚未发布，就用记录的逻辑 turn 发布 activation；如果 activation 已发布但 queue consumption 尚未记录，就删除精确 row 并关闭操作；如果没有任何持久阶段，queue row 仍可 promotion。任何阶段都不能因重启而二次接受 Roost，因为 acceptance 以 `operationId` 和 `userTurnId` 做幂等键。

用户看到的行为与 Loro 路径相同。恢复记录不是第二条消息，也不会被投影到会话 history。

### Queue 故障矩阵

| 故障点                  | Loro 结果                                        | Roost adapter 结果                           | 用户可见结果          |
| ----------------------- | ------------------------------------------------ | -------------------------------------------- | --------------------- |
| history acceptance 之前 | `prepared` receipt 保留，queue row 保留          | 保留可恢复的 `prepared` 操作                 | 消息继续排队          |
| history acceptance 之后 | 从 `history_accepted` 继续                       | 从 `history-accepted` 继续                   | 一个普通 turn         |
| activation 发布之后     | 从 `activation_published` 继续并消费精确 row     | 从 `activation-published` 继续并消费精确 row | 一个普通 turn         |
| commit 后重试           | 返回记录的幂等结果                               | ledger 返回 `already-applied`                | 不产生 duplicate turn |
| 并发 promotion          | rewrite lease 与 identity 检查选出一个逻辑 owner | operation identity 与恢复选出一个 owner      | 不重复执行            |

## Steer 生命周期

### 必须保留的状态机

Steer 是投递协议，而不只是一次 history append。现有 `steerMutationQueue` 按 session 串行化所有权变化，`steerStatusQueue` 串行化状态投影与 reconcile。rewrite-conflict lease 保护 Edit & Resend 及其他 history replacement 操作。expected turn ID 在 provider submission 前以及 handoff 边界再次检查。

状态保持不变：

- `pending_apply`：user input 已记录，但尚未被运行中的 turn 接受；
- `processing`：daemon 正在持有 steer handoff，等待 provider evidence；
- `handled`：provider 应用和本地 history 投影都完成；
- `canceled`：精确输入已取消，不得重放；
- `delivery_unknown`：provider 结果不能证明输入是否已被接受。

response disposition（`applied`、`no-active-turn`、`stale-turn`、`busy`、`unsupported`、`delivery-unknown`、`promotion-failed` 以及普通 error 路径）继续由这套状态机映射。只有明确证明发生在提交前的 provider refusal 才能转成普通 follow-up。timeout、缺少结果或传输歧义都不能授权自动重发。

### Loro 优先实现

Loro backend 继续保存现有 user history row 和 `steerTurnStatuses` metadata，并增加以下 backend 方法：

- 用 `userTurnId` 和 `operationId` 记录 steer intent；
- 为精确标识记录 provider delivery result；
- 把 status projection 应用到匹配的 history row；
- 读取 history evidence 做 reconcile；
- 只有 row 已经 terminal 或已经交给普通执行后才清理 status。

`reconcileSteerHistory` 调用 backend 方法，而不是直接调用 `sessionDoc.sessionData.history.readTurn`。现有顺序不能改变：先检查 settled history evidence，再决定 hold 或 requeue refused/pending steer；恢复逻辑先写 tombstone，再清理 steer status。当前 Loro 实现仍只有紧凑的 `steerTurnStatuses` mirror，还没有独立的 steer operation identity 或 provider result ledger；Roost adapter 在重启后恢复 steer 投递前必须补上这层持久身份。

Loro 实现可以继续把 status mirror 放在 session metadata 中，因为这已经是持久 control plane；抽象边界保证调用方不依赖这种表示方式。

### 未来 Roost 实现

Roost backend 必须持久化 steer identity、input、expected target、delivery kind 和 status，使进程重启后可以恢复。具体表示方式保持开放：Roost message metadata、dispatch-intent 扩展或 adapter 自有记录均可满足契约。本提案不要求新增顶层 Roost `steer_intent` message kind。

Loro control plane 可以继续携带用于唤醒和兼容现有客户端的精简 status mirror。对于 dispatch，这个 mirror 只是辅助信息；投递 identity 和 replay safety 的事实来源是 Roost ledger。reconcile 把 terminal evidence 导入普通逻辑 history projection，并只删除对应的 pending identity。

### Steer 强制规则

两个 backend 都必须满足以下规则：

- steer 只能结算它命名的精确 `userTurnId`。
- `unknown` 在后续 provider 或 history evidence 解决前保持 unknown；不能仅因本地进程停止等待就把它转换成可安全重试。
- Stop 只能提升已经证明 `not-applied` 的 steer，并遵守现有取消策略。
- successor turn 只有在上一个 run 的 handoff decision 通过 `steerMutationQueue` 串行化后才能接管。
- rewrite conflict 返回 `busy` 并保留 steer pending；不能在 Edit & Resend 持有会话时把输入 promotion 成普通 turn。

## MessageHandler 与 ACP 输出

### Target 创建与关联

ACP run 开始时，MessageHandler 创建 assistant target，包含逻辑 `userTurnId`、`assistantEntryId`、`turnId` 和单调递增的本地 `turnEpoch`，同时创建 ACP run token。provider 暴露 run identity 时将其纳入 token；没有时由 AgentClient 生成 token，并在整个 provider invocation 期间保持不变。

每个 ACP notification 在进入 `acpUpdateBuffer` 前都带上 target。这个标记贯穿 batching、retry、finalization 和 shutdown。flush 不能通过读取 `getCurrentACPUpdateTarget` 把旧事件重新绑定到当前 turn；即使 provider 发送稀疏更新，或者在 prompt 完成后才回调，也必须如此。

Target 生命周期为：

1. `begin`：创建或接管逻辑 assistant entry，并绑定 ACP run。
2. `append`：把文本、thought、tool item、附件、permission result、runtime config 和 usage 按 stamped target 批量写入。
3. `finalize`：等待 history gate，排空有上限的 flush 轮次，标记 target 完成，并保留晚到输出 target。
4. `late-append`：同一 run 的晚到输出继续写入保留的 target，并按通知粒度进行 at-least-once retry。
5. `retire`：只有 session deletion 排空 timer 和 in-flight flush 后才丢弃 target。

清理 turn 与删除 session 仍然是两件事。清理 turn 必须保留 buffer 和 in-flight flush；删除 session 必须先停止新 notification、排空或记录失败，然后删除 target 状态。

### Loro 优先实现

Loro backend 把 ACP 输出写入现有可变 assistant entry。finalization 通过现有 history action 设置终态字段。晚到输出继续更新同一 entry，所以 UI 只看到一条 assistant 消息。现有 batching window、有上限的 retry 轮次、target-local 分组、unread marker、usage flush、permission wait 以及附件/tool 绑定在语义上保持不变。

adapter 边界放在 `appendACPUpdatesToAssistantEntry`、`finish-assistant`、usage 持久化和 rich-content 持久化周围。MessageHandler 负责事件顺序和 target identity；backend 负责逻辑 target 的物理表示。

### 未来 Roost 实现

Roost 把普通流式输出写入逻辑 assistant `businessId` 的 primary segment，并在 finalization 时 seal。seal 之后到达的输出写入同一 `businessId` 的后续 segment，使用新的 `segmentId`。`HistoryProjection` 把这些 segment 合并成一条逻辑 assistant entry，并保持事件顺序和 terminal metadata。

晚到输出不能调用 `forkAndActivate`。`forkAndActivate` 只用于 Edit & Resend，因为那是用户明确创建 replacement active branch 的操作。若每个晚到 callback 都调用它，会生成用户可见的 branch 变化，让 activation 复杂化，并把 provider timing 暴露到历史中。

usage、permission result、附件和 tool item 都携带相同的 `businessId` 与 ACP run token。没有匹配 target 的晚到 item 进入现有有界 retry/error 路径，不能猜测性地绑定到最新 active turn。

Roost 目前已有的 `businessId`/`segmentId` 物理表示与该规划兼容，但仍需要 adapter 或 projection 层，因为原始 active-branch read 可能返回物理 segment，而不是一条逻辑 assistant entry。

### MessageHandler 故障矩阵

| 故障点                            | 必须行为                                                         |
| --------------------------------- | ---------------------------------------------------------------- |
| user history 尚未在本地           | history gate 延迟写入，notification 保留在带 target 的 buffer 中 |
| prompt 返回但 provider 继续输出   | finalization 保留 target，晚到 notification 更新该 target        |
| batch 部分持久化                  | 按 notification 记录进度，只重新排队未写入项，不重复已写 prefix  |
| flush 连续失败                    | 停止自动 retry，但 buffer 保留给后续显式或生命周期 drain         |
| 旧 turn 期间新 turn 开始          | 新 run 使用新 token，旧事件仍绑定旧 target                       |
| session deletion 与 callback 竞争 | deletion 边界拒绝新更新，等待 in-flight 完成，再删除 target 状态 |

## Edit & Resend 与 sealed turn

sealed-turn 约束在 Roost 操作层已经有对应解决方案：编辑已有消息时保留 sealed 旧 turn，创建 replacement turn，然后通过 `forkAndActivate` 原子切换 active branch。过渡边界把它暴露为 `HistoryEngine.editAndResend`；调用方不能修改 sealed turn，也不需要知道 replacement 是 Loro copy 还是 Roost fork。

Edit & Resend 进行时，queue 与 steer 必须服从 rewrite-conflict lease。并发 steer 返回 `busy` 并保持 pending；queue promotion 观察到 lease 后不能把输入 claim 成普通 turn。replacement branch 激活后，普通 dispatch 读取新的 active logical history。旧 sealed 内容仍可用于 branch/history 检查，但不会重复进入 active conversation。

这也是晚到 ACP 输出必须成为独立操作的原因：provider callback 是已经拥有的 assistant target 的证据，而不是一次 edit request。

## 性能与用户可见行为

过渡会给每次操作增加一次接口调用和稳定标识，但不能给 hot path 增加第二次全历史扫描。queue promotion 和 steer reconcile 只读取精确操作所需的 identity 与 row；assistant streaming 继续使用 target-local batching。Loro backend 维持当前 document write model，因此抽象本身不能解决已知的长对话 LoroDoc 成本；实际性能收益来自未来新会话使用 Roost，而旧会话在 Loro 上保持行为兼容。

Roost projection 必须增量化且有界。它应缓存 `businessId` 到逻辑 assistant entry 的映射，只使变化的 ID 失效，不能为了每个 token batch 重新物化全部旧 segment。任何 projection 成本都应留在内部；用户看到的 streaming cadence、queue status、steer result、edit result 和消息顺序应保持不变。

埋点记录与 backend 无关的操作耗时和结果数量：queue promotion latency 与 retry、steer status transition、target flush latency 与 buffer bytes、projection 工作量和 recovery phase。日志默认只记录 opaque ID 与 phase，不记录 prompt 或 assistant 内容。

## 实施顺序

### 阶段 1：只使用 Loro 的过渡 API

- 在 Lody session layer 定义四个边界和结果类型。
- 基于现有 Loro `SessionDocument`、history command、metadata 和 transient target state 实现它们。
- 把 queue promotion、steer reconcile、assistant lifecycle 和 history read 移到接口之后。
- 保持现有 UI protocol 以及 status/disposition 词汇不变。
- 增加 session backend discriminator，并把旧会话默认解释为 `loro`。

### 阶段 2：契约与故障测试

- 用 fake backend 和真实 Loro backend 跑同一组 queue、steer、MessageHandler 场景。
- 覆盖 forked Loro replica 上的重复 queue promotion、activation 发布重试、settled/refused steer race、unknown delivery、handoff 中 Stop、Edit & Resend conflict、晚到 ACP 输出、batch 部分失败和 session deletion。
- 断言逻辑 history 和用户可见 status，不断言 Loro container ID 或实现调用次数。
- 添加 long-history benchmark，对比当前 Loro 路径与 adapter 路径；adapter 不能引入第二次全文档读取，也不能在约定的 batching overhead 之外造成可测量的 streaming 回归。

### 阶段 3：不启用生产选择的 Roost adapter

- 在同一契约后实现 Roost history acceptance、持久 delivery operation record、assistant segment projection 和 recovery。
- 验证 `businessId` 分组、sealed primary 加晚到 segment、每个 queue phase 的重启恢复以及 steer settlement 幂等。
- 在 adapter 通过契约测试前，只通过测试或 session fixture selector 使用 Roost。

### 阶段 4：新会话选择

- 通过 session factory 只为新建会话启用 Roost。
- 旧会话固定在 Loro，并且只在诊断信息中显示 backend 选择。
- 观察 backend 无关的 metrics 和 recovery 结果后，再扩大选择范围。

## 验证计划

最低验收套件分四层：

1. queue 与 steer identity、状态转换、retry 分类和 operation 幂等的纯状态机测试。
2. 使用 `SessionDocument`、`HistoryWriter`、metadata 和 forked replica 的真实 Loro 集成测试，验证抽象保留 last-copy lookup、activation 语义和现有 duplicate-copy 防护；当前 steer ledger 尚未完整，测试必须明确这一边界。
3. 使用 fake ACP provider 的 MessageHandler 生命周期测试，覆盖 history sync 前输出、prompt 完成后输出、新 turn 期间输出、部分持久化后输出和 deletion 期间输出；断言逻辑 assistant ID 与内容顺序。
4. 对 Loro 和 Roost adapter 运行相同的 backend contract test。Roost 用 crash injection 覆盖每个跨存储阶段；Loro 覆盖 receipt 阶段、定向重试读取、activation 修复和 queue 顺序保持。

long-history benchmark 和真实 provider lifecycle test 运行前不宣称任何性能数字。Roost adapter 在生产 Roost library 上实际运行前，不把任何 Roost-specific API 当作已确认事实。这些是验证边界，不是改变 Loro-first 方案的理由。

## 仍需证据的事项

真正仍未确认、且只属于 Roost 的事项只有以下几项：

- Roost 哪个 persistence hook 和 metadata 形状适合承载 delivery ledger，既保证 operation recovery 持久化，又不强制新增顶层 message kind。
- Roost 是否能提供高效的 active-branch projection hook，还是需要 Lody adapter 自己维护增量 business-ID index。
- 哪些 provider adapter 会提供稳定 run identity；没有时由 Lody 生成的 run token 作为本地关联依据。
- 长 streaming response 下的 segment/projection 和持久化实测成本，尤其是 finalization 后仍有晚到输出时的成本。

这些事项不会改变 Loro 实施计划；它们是启用 Roost 新生产会话前必须完成的 adapter 验证工作。
