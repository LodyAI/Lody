# Outbox 发送与会话 Reserve

## 问题

发送后乐观进入 MessageList，请求可能还在本机队列里，服务端尚未接到。此时回到首屏会卸掉 `useSessionSend` 和前台 `watchSession`。

现有访问 LRU（前台 1 + 后台 3）会继续 long-poll 最近看过的会话，但：

- `sendTurn` 要求 `active === 当前会话`，`closeSession` 之后对保活副本发送是 `not_sent`
- Swift `sendTurn` 还要求 `args.sessionId ==` 前台 `sessionId`
- 新建会话在 `creation` 阶段没有 `openSession`，根本不在 `sessions` Map 里
- outbox 调度只挂在 MessageList 上

结果：乐观 UI 已经更新，回首屏后创建/第一句可能停住或被 abort。机器一旦 ACK，远端会自己跑；没 ACK 的那一段没有人接手。

## 决定

复用现有 `sessions` Map 和 Durable Streams long-poll，不另做保活协议。

发送生命周期从 MessageList 解绑，改由工作区级 outbox 调度。会话订阅分三层：

| 层       | 名额                | 谁决定                             | 可否逐出        |
| -------- | ------------------- | ---------------------------------- | --------------- |
| 前台     | 1                   | 当前 MessageList 的 `watchSession` | 离开即卸前台    |
| 访问 LRU | 3                   | 访问顺序（现有）                   | 可逐出          |
| Reserve  | = 未确认 pending 数 | 乐观 outbox                        | 不可被 LRU 挤掉 |

Reserve 只覆盖「服务端还没接住」的窗口。机器 ACK 之后，仍有工作才进入 LRU 热端；再打开其他工作会话可以被逐出，远端任务不取消。空闲会话仅在前台同步，不进入后台 LRU，也不因浏览空闲会话挤走已有工作副本。未结束的助手回合、已提交但尚未收到助手事件的用户消息、待执行队列属于工作；单纯连接 live 不属于工作。工作结束后离开后台 LRU。

实现里加安全顶 8：超过时新的 `waiting` 不 `ensure`、不 dispatch；已在 reserve 的不踢。这是防打满，不是产品配额。用户再进该会话走前台，不受这个顶限制。

## 所有权

`CatalogProvider` 已经订阅 pending。工作区调度和它放在一起。MessageList 只负责提交草稿、渲染 `pendingSendJSON`、重试 `failed`。回首屏卸掉页面，不能卸掉发送。

前台 `watch` / `unwatch` 不再承担「保证副本存在」。`watchSession` 只设置 RN 前台指针（native `sessionId` + JS `active`）。Reserve 使用不改前台指针的 `ensure(sessionId)`：副本进入 Map，`active` 和 Swift `sessionId` 仍指向当前页面（没有页面则为空）。

`sendTurn` 按 `sessions.get(sessionId)` 找副本，不再要求 `active === 当前`。Swift 对 `sendTurn` 放宽「必须等于前台 sessionId」，否则 JS 保活了原生仍拒发。

新建会话在 `creation` 阶段还不在 Map 里。调度在 `createSession` 成功后 `ensure` 进 reserve，再发第一句，不依赖用户是否还留在 MessageList。

首页只看 catalog / Live Activity，不为收流再挂一套 RN 会话订阅。

## 数据流

1. **提交**（MessageList 或新建 sheet）：先 `outbox.put(waiting)`，立刻乐观推进 MessageList。调度不依赖这次导航是否成功。
2. **调度**（页面在不在都跑），对每条未完成 pending：
   - 有 `creation` 且已连接 → `creating` → `createSession`（工作区命令，不需要前台 session）
   - 创建成功 → 清掉 `creation`，phase 回到 `waiting`，`ensure(sessionId)` 放进 reserve
   - 无 `creation` 且副本 `live` → `sending` → `sendTurn`（目标 `sessions.get(id)`）
   - 机器 ACK → `accepted` / `queued`，从 reserve 毕业，Map 里挪到 LRU 热端
3. **回首屏**：`unwatchSession` 只卸前台。`trimSessions` 跳过 reserve。进行中的 `createSession` / `sendTurn` 不因 `active` 变化 abort。
4. **毕业之后**：replica 仍 long-poll，事件走 `sessionCache`（写本地、更新 background task）。Catalog 照常推首页。此时它是普通 LRU。
5. **再进入**：`watchSession` 设回前台。命中 Map 则 promote + 刷当前投影，不重新 bootstrap。MessageList 不重新 dispatch；outbox 若已 `accepted`，等助手行出现再清草稿（现状）。
6. **首页再发一条新会话**：又一条 pending → 又一路 reserve。旧的若已 ACK 只占 LRU；若还没 ACK，两路 reserve 并存。

`ensure` 时若副本已在 LRU 里，只标记 reserve，不重新 bootstrap。

Live tail 仍是 Durable Streams HTTP long-poll（`GET …/ds/lody/{id}?offset=&live=long-poll`），不是 WebSocket，也不改成 SSE。

## 失败与边界

**`failed`**：确定失败（`not_sent`、`rejected`、可展示业务错误）。outbox 记 `failed`，立刻离开 reserve。草稿保留，只有用户点重试才再进 reserve。

**`unknown`**：写可能已经上云、ACK 丢了。不自动重放。留在 reserve，继续挂流，直到出现任一投递证据再清 outbox 并毕业：副本 history 里该 `send.id` 用户行之后有助手行，或 catalog 的 `latestUserMsgId` / 队列水位等于该 id。没有证据时不能点重试；在此之前它一直占一路 reserve。

**进行中被离开**：`creating` / `sending` 的那次 JS 调用继续跑。若在 `ensure` 之前原生就拒了，调度看到确定 `not_sent` 且未 `writeStarted`，允许对同一 `send.id` 再 dispatch 一次（调度重试，不是写重放）。已经 `writeStarted` 的走 `unknown`，禁止重放。

**安全顶 8**：Reserve 路数 = 未确认 pending 数。超过 8 路时，新的 `waiting` 不 `ensure`、不 dispatch，outbox 保持 `waiting`。已在 reserve 的不踢。

**逐出**：`trimSessions` 跳过前台和 reserve，先回收空闲副本，再按访问顺序保留最多三路后台工作副本。恢复中的副本等首个完整快照判断工作状态，不提前挤占名额。毕业后若超预算，该会话变成可逐出。被逐出时 flush 最后一帧 `sessionCache`，再 abort 该路 long-poll；已完成的后台任务正常结束，未完成的本地后台同步标失败，不取消远端 agent。

**附件**：上传任务跟 `sessionId` 绑，不跟当前前台绑。离开 MessageList 或打开另一个会话，不得 cancel 这条 reserve 的上传。多路附件可以串行，不许误杀。

**运行时被换掉**：WebView 重建时 `restoreSessions(ids, current)` 的 `ids` 必须包含 LRU ∪ reserve，`current` 仍是前台（可为 null）。重建后调度从 outbox 接着走，不重放已 `unknown` 的写。

**首页并发**：另开新会话、进别的会话、刷 catalog，都不等这条发送结束。它们只可能把已毕业的副本挤出 LRU，挤不走 reserve。

## 不做

- 不为收流再挂一套 RN 订阅
- 不自动重放 `unknown`
- 不把 `failed` 留在 reserve
- 不在回首屏时保持 native 前台 `sessionId`
- 不把 ACK 之后的流式保活做成无限钉住
- 不改 Durable Streams 协议，不改用 SSE
- 不做真机长时间后台保活保证（短 `beginBackgroundTask` 只覆盖发送 ACK，到期不取消远端 agent）

## 测试

现有检查继续有效，并改掉过时断言：`closeSession` 之后对保活会话 `sendTurn` 不再必须是 `not_sent`；无前台时订阅上限改为「最多 3 路普通 LRU + reserve」。

运行时：

- 未确认 pending 的会话在连开 3 个其他会话后仍在 Map，long-poll 未 abort；毕业后可被同样操作逐出
- `closeSession` 只卸前台：进行中的 `sendTurn` 跑完到 `accepted` / `queued`
- 副本已在 LRU 时 `ensure` 不重新 bootstrap
- `unknown` 不二次 `append`；`failed` 不占 reserve
- 第 9 路未确认 pending 不 `ensure`；已在 reserve 的不被踢
- `restoreSessions(ids, current)` 的 `ids` 含 reserve ∪ LRU，`current` 可为 null

调度（无 MessageList）：

- 只有 outbox + 工作区调度即可 `waiting` → 创建/发送 → `accepted`
- 创建成功后离开：第一句仍会发出
- 卸载页面不取消已启动的那次调用；`writeStarted` 后失败仍是 `unknown`
- 同一 `send.id` 在未写盘、确定 `not_sent` 时允许调度再 dispatch 一次

原生：

- `sendTurn` 在前台 `sessionId == nil` 时，只要 JS 侧会话仍 retained/reserve，命令能进去
- 离开页面或切换前台，不得 cancel 该 session 的附件上传

不测：首页截图当发送成功证据；真机长时间后台保活；SSE。

UI：现有 `send-handoff` 继续覆盖「发送后立刻进 MessageList」。有 Debug 桩时再加：发送 → 立刻回首页 → 桩给出 ACK → 再进会话能看到用户行且不是重新 bootstrap 的空历史。
