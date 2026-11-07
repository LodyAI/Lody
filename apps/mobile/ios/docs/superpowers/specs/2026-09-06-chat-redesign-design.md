# 聊天页重构

承接 `2026-09-06-design-language-design.md`。那份文档明确「聊天页另行讨论」，本文是那次讨论的结果。

优先级由高到低：**内容表达**与**原生手感**并列第一，交互控制次之，结构重构垫底——但内容表达一旦落地，结构重构是它的副产品，不单独排期。

## 问题

`SessionScreen.tsx`（305 行）和 `MessageBubble.tsx`（230 行）目前的实现有三个层次的缺口。

**最外层是死内容。** `projectHistory` 把每个 `MessageContent` 压成 `{type, text, label}`，`text` / `thought` 之外的一切渲染成灰框加一句「完整内容可在电脑上查看」。coding agent 的转录有大半是工具调用，这等于把主体内容扔了。其中 `tool_call.permissionRequest` 被扔掉的后果不是可读性差，是**会话死锁**——agent 停下来等一个手机端永远给不出的答复。

**中间层是手感。** `KeyboardAvoidingView` 包 `ScrollViewMarker` 包 `FlatList`，三层各自算 inset，键盘弹出会抖。滚动跟随是手写的 `following.current` + `onScroll` 阈值 + 两处 `scrollToEnd`。

**最里层是管线。** 每次 doc 更新，data-runtime 执行 `doc.toJSON()` 全量 → 投影整段 history → `JSON.stringify` → WKWebView 桥 → Swift → RN 桥 → `JSON.parse` → 整体替换 state。流式回复时这条链路按 token 批次触发。现在只传三个字段所以还扛得住；一旦把工具内容带上，一个跑了半小时的 session 轻松几 MB，每帧全量序列化一次必卡，`DataRuntime.swift:121` 的 12 MiB 上限也会开始撞。

三层缺口是连着的：不修管线就带不动内容，不带内容就谈不上手感。

## 范围

**做**：`tool_call`（含 `kind` / `status` / `content[]` / `permissionRequest`）、`plan`、`subagent_task`、`thought`、`text` 的渲染；权限内联作答；摘要投影 + 按需详情；键盘与滚动交给系统 API。

**不做**：`image` / `image_group` / `file` 附件（依赖 R2 下载链路，与 UI 重构不是一件事）、`worktree_script`、`system_notice` 的完整渲染、中断正在跑的 turn、消息长按重发与编辑、冷启动缓存。

冷启动白屏（进会话先转圈等服务端 bootstrap）是真实缺口，但 LodyKit 的 SQLite 恢复层正在被另一条线改动，且摘要投影的 schema 要先定稳才谈得上持久化它。本轮只做体面的加载态，并把 snapshot 来源收敛成单一入口，以后接缓存不碰 UI。

## 视觉语言

参照 Codex 的转录呈现。核心是**安静**：整屏只有助手正文有完整对比度，其余全是灰阶层级，没有卡片边框、没有头像、没有「LODY」标签。

```
                                  帮我看下登录为什么会超时     ← 用户，右侧气泡

                                                19:32   ⧉    ← 轮次头：时间 + 复制
已工作 4 分 20 秒                                             ← 灰字
─────────────────────────────────────────────────────────    ← hairline

我先看了 src/auth.ts 的请求链路，超时来自 fetch 没有挂         ← 助手正文，全宽，无气泡
AbortSignal。

􀤋  读取了文件、执行了命令                                ›    ← 活动行，灰字，可点
```

规则：

- 用户消息是右侧气泡（`colors.fill`），助手是全宽正文。**唯一**的气泡在用户侧。
- 轮次头：右上角时间 + 复制图标，下一行「已工作 N 分 M 秒」（`endedAt - Date.parse(timestamp) - permissionWaitMs`），再一条 hairline。
- **工具活动按连续同类聚合**成一行灰字，不是一个 `tool_call` 一张卡。聚合规则见下。
- 活动行点开走**原生 sheet**，不内联展开。
- 零边框零卡片。视觉分层只靠灰度和 hairline。

### 活动行的聚合

连续的 `tool_call` 合成一行，`kind` 决定图标与措辞；被 `text` / `thought` 打断则起新行。

| kind 集合                            | 图标                       | 措辞                               |
| ------------------------------------ | -------------------------- | ---------------------------------- |
| `read` / `search`                    | `doc.text.magnifyingglass` | 读取了文件                         |
| `edit` / `write` / `move` / `delete` | `square.and.pencil`        | 编辑了 `<path>` +N −M              |
| `execute` / `bash`                   | `terminal`                 | 执行了命令                         |
| `fetch`                              | `globe`                    | 访问了网络                         |
| `mcp` / `other` / `computer`         | `wrench.and.screwdriver`   | 调用了工具                         |
| 混合                                 | `wrench.and.screwdriver`   | 逐类顿号连接，最多三类，超出「等」 |

单个 `edit` 独占一行时显示 path 和 `+N −M`；多个合并时只给类别措辞。

`+N` / `−M` **在 runtime 侧算好后进 `ItemSummary`**，不在 `aggregate.ts` 算——`content[]` 不进流，RN 侧根本拿不到 diff。算法是逐行比对 `diff.oldText` / `newText` 数出增删行数，不是总行数相减（总行数差只给得出净值，给不出分别的增删）。

`status: 'in_progress'` 的活动行末尾带一个小 spinner，不换措辞。失败（`status: 'failed'`）的行转 `danger` 色，措辞前缀「失败：」。

`plan` 与 `subagent_task` 各自独占一行，不参与聚合。

## 投影：摘要 + 按需详情

`projectHistory` 停止全量投影，改为**正文全量、工具摘要**。

助手正文本身就是阅读内容，截断它等于读一段话还要二次加载——所以 `text` / `thought` 的 `text` 字段完整进流。工具的 payload 不进流：`content[]`、`rawInput`、`rawOutput`、完整 terminal 输出一律留在 doc 里，用户点开 sheet 时才取。

这条设计和「详情走 sheet」的 UI 决策是同一件事的两面：sheet 本来就是异步呈现，天然容得下一次取数。

### 载荷信封

```
{
  v: 1,
  sessionId, generation, revision,
  status, reason,
  awaitingUserSince?: number,
  entries: [{
    id, rev, role, status, finished,
    timestamp, startedAt?, endedAt?, permissionWaitMs?,
    items: [ItemSummary]
  }]
}
```

`generation` 标识 data-runtime 实例，重启后自增；RN 丢弃 generation 落后于当前的载荷。`revision` 单调递增，用于乱序保护。

`ItemSummary` 按 type 分派，共有字段 `{ itemId, rev, type }`：

| type            | 附加字段                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `text`          | `text`（全量）                                                                                               |
| `thought`       | `text`（全量）                                                                                               |
| `tool_call`     | `kind`, `title`, `status`, `path?`, `added?`, `removed?`, `hasDetail`, `permission?: { requestId, pending }` |
| `plan`          | `entries: [{ content, status, priority }]`                                                                   |
| `subagent_task` | `taskId`, `status`, `actor?`, `description?`                                                                 |
| 其余            | 仅共有字段 —— RN 渲染成一行中性活动，不再出现「请在电脑上查看」                                              |

`entry.id` 是现成的：`sessionDocSchema.history` 用 `(item) => item.id` 键控（`schema.ts:1090`）。

`items` 那层没有键控函数（`schema.ts:546` 第二参数是 `undefined`），所以 item 没有现成 id。`itemId` 的取法：

1. `tool_call` 用 `toolCallId`
2. 其余用 `LoroList.getIdAt(pos)` 返回的 `{peer, counter}`，序列化成 `${peer}:${counter}`

**绝不用数组下标或内容哈希**——下标在并发插入下会漂移，哈希在流式追加时每帧都变。

关键约束：`getIdAt` 只在 LoroDoc 上可调用，**`toJSON()` 会丢掉容器身份**。所以 itemId 必须在 WKWebView 里的投影阶段读出来写进载荷，RN 侧无法事后恢复。当前 `projectHistory(doc)` 走的是 `doc.toJSON().history`，这条路径要改成遍历 `LoroList` 本身。

`rev` 由 runtime 计算并写进载荷，规则：某个 item 的任一投影字段变化时，该 item 的 `rev` 自增，其所属 entry 的 `rev` 也自增。**不能靠对象引用相等来判断**——载荷跨 JSON 桥序列化，引用不保留。RN 侧的 `memo` 比较 `(itemId, rev)`，sheet 的保鲜判断同样。`generation` 变化时所有 `rev` 归零重来。

Swift 只透传这个信封，不解析 `items`。新增 item type 不需要动 Swift。

### 节流

节流放 data-runtime，`emit` 之前，且**不能只节流 emit**。只挡桥不挡 CPU 的话，每次 doc 更新照样跑一遍 `toJSON` 和全量投影。所以：

1. 按脏 entry 缓存投影结果。doc 订阅给出变更路径，只重投影受影响的 entry，其余复用上次的对象引用（这也让 RN 侧的 memo 直接命中）。
2. 正文追加走尾沿节流：100 ms 尾沿，最长等待 200 ms。
3. **状态翻转、turn 完成、出现待授权请求：立即刷新**，不进节流队列。这三类是用户在等的信号，延迟 200 ms 就能被感知。

Swift 和 RN 不再叠加节流。

**这套省的是什么，不省什么**：省掉的是工具 payload——`content[]` / `rawOutput` / terminal 输出通常占一个长会话的绝大部分体积，它们不进流。**正文不省**：`text` / `thought` 全量进流，且每次 emit 仍要把整个信封 `JSON.stringify` 一遍，脏 entry 缓存只省投影的 CPU，不省这一次序列化和过桥。所以载荷体积与「会话的正文总量」仍然线性相关，只是与「工具输出总量」脱钩了。判断依据是后者通常大一到两个数量级；这个判断需要在第 1 步用真实长会话实测，不成立就直接上增量投影。

### 按需详情

新增 `sessionItemDetail(entryId, itemId, cursor?)`，沿用现有 Swift → WebView `callAsyncJavaScript` 的请求/响应模式。请求带请求编号、`generation`、已知的 `rev`；响应回 `content[]` / `rawInput` / `rawOutput` 的完整内容，超长的 terminal 输出分页（`cursor` + `nextCursor`）。

sheet 打开时**原子地**注册订阅并取快照。之后 data-runtime 只推该 item 的 `rev` 失效通知，sheet 收到后重读——不轮询。sheet 关闭时退订。

**WKWebView 被系统回收 / runtime 重启后**：`generation` 由 Swift 维护并自增，但 generation 变化的那一刻 session 还没 bootstrap 完，此时重订阅必然落空。所以恢复流程是：丢弃在途响应与旧 cursor → 等该 session 重新到达 `live` → 才重建订阅并重取快照。sheet 在这段窗口里显示加载态而不是错误态。每个请求与响应都携带 `(sessionId, generation, itemId, rev)` 四元组，任一不匹配即丢弃，避免分页游标串页。

响应也要限额：单次响应体上限（建议 512 KiB），超出走 `cursor` 分页；单个 diff 的 `oldText`/`newText` 超限时只回可视区域并标注截断。不能因为「详情是按需的」就假设它一定小。

`hasDetail: false` 的 item 不给点击态。

## 权限

`tool_call.permissionRequest` 有 `requestId`、`options[]`，无 `outcome` 即待答。作答就是往 LoroDoc 写 `permissionRequest.outcome`——桌面端 `workspace-writer-impl.ts:148` 就是这么做的，**不走 RPC**。机器订阅 doc 等这个字段。

`SessionMeta.awaitingUserSince`（`schema.ts:898`）在 session doc 的 `session` 根字段里，会话页读得到。但它按自己的注释是「a list-rendering summary of the durable truth in history」——**派生摘要，不是真相**。真相始终是 history 里那个没有 `outcome` 的 `permissionRequest`。

所以分工是：`awaitingUserSince` 只用于快速判断「有没有在等」（会话页的横幅、列表页的角标）；要弹哪个请求、`requestId` 和 `options[]` 是什么，一律从 history 的 item 取。机器在 resolve 时会 `clearAwaitingUser()`。

（收件箱的「需要你」分区目前靠 `sessionStatus()` 推断，改用这个字段更准，但那是收件箱的事，不在本轮范围内，只在此记一笔。）

### 何时弹

满足三条时**自动** `present`：用户正停留在该会话页、请求是新出现的（本次呈现未展示过该 `requestId`）、`outcome` 仍为空。

**必须用 `style: 'formSheet'`，不能用 `pageSheet`。** `PresentedPage.tsx:118` 的 `formSheet` 判断只对 `formSheet` 成立，`sheetAllowedDetents` / `sheetGrabberVisible` / `sheetInitialDetentIndex` 三个字段在 `pageSheet` 下全部传 `undefined`（`PresentedPage.tsx:139-147`）。类型上允许不等于运行时生效。活动行详情 sheet 同理。

`sheetAllowedDetents: 'fitToContents'`，选项按钮直接来自 `options[]`，不硬编码「允许 / 拒绝」。

用户滑掉 sheet **不写任何 outcome**，本次呈现对该 `requestId` 去重不再自动弹；转录里该活动行转 warning 色并显示「等待你的批准 ›」，点击重新打开。

### 写入路径与 `sendTurn` 的区别

|          | `sendTurn`                                   | 权限作答                   |
| -------- | -------------------------------------------- | -------------------------- |
| history  | 新增 entry                                   | 不新增                     |
| 后续动作 | Streams RPC `session/dispatch-turn` + 等 ACK | 无                         |
| 失败语义 | 已保存待确认 / 结果未知                      | 直接失败，可重试           |
| 重启后   | 不自动重放（`autoSent` ref）                 | 不自动重放，重读 `outcome` |

提交前校验三件事：`requestId` 仍是当前待答的、选中的 option 在 `options[]` 里、`outcome` 仍为空。重复提交同一答案视为成功；`outcome` 已存在且不同则拒绝并以 doc 为准刷新 UI。

**写进本地 doc 不等于机器收到了。** 本地 `outcome` 落盘只是第一步，还要等这次更新经 Streams 推上去。所以 sheet 的按钮在本地写入后不立即关闭，而是进「提交中」态，直到该更新被确认上传（复用 `sendTurn` 里 `client.append` 的 ok 判定）才关闭。上传失败：sheet 保持打开、按钮恢复、显示原因，由用户决定重试。

结果不明时**先重读 `outcome`**再决定，不盲目重发——符合项目硬规则「Never automatically replay writes across runtime recovery」。

**已知偏差**：机器端 `message-handler.ts:8618` 用 `let resolved = false` 守着，第一个到达的 outcome 生效、后续忽略，所以两台设备同时作答不会执行两次。但 CRDT 是 LWW，doc 里最终显示的 outcome 可能不是机器实际采纳的那个——即「界面显示你拒绝了，实际执行的是另一台设备的允许」。这不是纯显示问题，用户可能据此做出错误判断。本轮不做补偿（需要机器回写采纳结果才能根治），但必须在验收里确认这条路径的表现，并记入已知问题。

## 原生手感

三个已验证的事实决定了实现层级：

- `InputAccessoryView` 是 RN 内置的（`react-native/Libraries/Components/TextInput/`），直接挂在 iOS 键盘上。装了它就**不需要 `KeyboardAvoidingView`**，composer 跟随键盘是系统行为。
- `maintainVisibleContentPosition` ScrollView 支持，但**它不是贴底跟随**。读 `ScrollView.d.ts:435-456`：它保证「已可见的第一个子元素位置不变」，`autoscrollToTopThreshold` 是「调整后如果用户原本靠近**顶部**就自动回顶」——是为倒置聊天列表设计的。非倒置列表里末条正文增高，它不会把你带到底。手写跟随**不能整段删掉**，只能简化。
- `PagePresentationOptions` 已经支持 `sheetAllowedDetents: 'fitToContents'`，sheet 自适应高度不用新写原生件。

所以：RN 内置件打底，LodyKit 只补两件真的缺的。

**RN 侧**

- 删 `KeyboardAvoidingView`，composer 移入 `InputAccessoryView`
- 滚动跟随：保持非倒置列表（倒置会让轮次头、hairline、`softScrollEdgeEffects` 全部要反过来，代价大于收益）。`maintainVisibleContentPosition: { minIndexForVisible: 1 }` 只用来防止历史补齐时跳动；贴底跟随保留一个最小实现——一个 `nearBottom` ref + `onContentSizeChange` 时 `scrollToEnd`，比现在少掉 `showJump` 那套阈值分支。**这条要在模拟器上实测流式追加的表现，不成立就退回倒置列表方案。**
- `ScrollViewMarker` 继续包 `FlatList`，`softScrollEdgeEffects` 保留

**LodyKit 新增**

1. `LodyContextMenu` —— `UIContextMenu`，助手正文长按复制。RN 的 `selectable` 在长正文里选择体验差，且拿不到「复制整条」这个动作。
2. 活动行的 SF Symbol —— 复用现有 `LodySymbolButton` 的 symbol 解析路径，不新造组件。

`sheetAllowedDetents` 与 haptic（`selectionFeedback`）用现成的。

## 结构

```
features/sessions/
  SessionScreen.tsx          订阅 + 发送 + 布局，目标 150 行内
  transcript/
    Transcript.tsx           FlatList + 跟随策略
    TurnHeader.tsx           时间 / 已工作 / 复制 / hairline
    UserBubble.tsx
    AssistantProse.tsx       MarkdownBody 的容器
    ActivityRow.tsx          聚合后的一行
    aggregate.ts             ItemSummary[] → 渲染行，纯函数，node test 直跑
  detail/
    itemDetailPage.tsx       definePage，活动行详情 sheet
    permissionPage.tsx       definePage，权限 sheet
ui/
  MarkdownBody.tsx           设计语言文档里挂账的那个组件
```

`aggregate.ts` 是纯函数、零 RN 依赖，与 `inbox.ts` 同样用相对路径 + `.ts` 后缀导入，`node --test` 直接跑。聚合规则与状态措辞在这里。（`+N −M` 不在这里，见上文——它在 runtime 侧算。）

`node --test` 覆盖的不只是聚合，还有三处同样纯逻辑、同样容易出错的行为：**信封的乱序与 generation 丢弃规则**、**权限提交的三项前置校验**（requestId 当前、option 合法、outcome 为空）、**因果排序在新投影下不回归**。这三处比聚合更值得测——聚合错了看得见，它们错了看不见。

`MessageBubble.tsx` 删除，内容拆进 `transcript/`。

## 错误与降级

- **载荷超 12 MiB**：`DataRuntime.swift:121` 现在静默丢弃**整帧**——不是「旧消息缺失」，是这一次更新完全没送达。改为 Swift 侧发一个 `{ overflow: true, generation, revision }` 的空信封；RN **保留上一份完好快照**继续渲染，并在顶部显示「同步已停止 · 内容可能不是最新」。不静默，也不清空。
- **`sessionItemDetail` 失败**：sheet 显示错误态与重试按钮，不关闭 sheet。
- **权限提交失败**：sheet 保持打开，按钮恢复可点，显示原因。不自动重试。
- **generation 不匹配**：丢弃载荷与在途响应，不报错——runtime 重启是正常的后台恢复路径。
- **未知 item type**：渲染中性活动行，不显示占位文案。

## 已知上限

摘要投影砍掉 payload 之后，12 MiB 上限大概率触不到。但很长的会话（几千条 entry，正文全量进流）理论上仍可能超。本轮不做分页，只做上面那条显式降级。真顶不住时的升级路径是**增量投影**：data-runtime 只发变化的 entry，RN 按 id 合并。这需要在 CRDT 侧做 diff 追踪，单独一轮。

## 实施顺序

1. **投影管线** —— `ItemSummary` schema、itemId/rev、脏 entry 缓存、节流、信封。此步换掉旧信封，所以下列几处必须**同一步**改完，否则仓库不可构建：
   - `projectHistory`：从 `doc.toJSON().history` 改为遍历 `LoroList`（否则拿不到 `getIdAt`），同时**保留现有的因果排序**（`userTurnId` 分组那段逻辑不能丢）
   - `session.ts` 两处 emit 出口（`openSession` 里的 `event()` 和 `sendTurn` 里的那处）都要发新信封
   - `SessionScreen` 的 `Array.isArray(data.messages)` 校验改为按 `v` / `generation` 判定
   - `MessageBubble` 降级为读 `ItemSummary` 的最小渲染（正文照旧、其余一行灰字），不追求最终形态
2. **`aggregate.ts` + 单测** —— 纯逻辑，无需构建。
3. **转录渲染** —— `MarkdownBody`、`TurnHeader`、`ActivityRow`、拆 `MessageBubble`。
4. **键盘与滚动** —— `InputAccessoryView` + `maintainVisibleContentPosition`，删手写跟随。
5. **`sessionItemDetail` + 详情 sheet** —— 请求/响应、订阅保鲜、分页。
6. **权限 sheet** —— 自动呈现、写 `outcome`、`awaitingUserSince` 接入。
7. **`LodyContextMenu`** —— 长按复制。

1、5、6 涉及 data-runtime，需要 `pnpm native:assets` 重新打包 data-runtime 后再构建。7 涉及原生，需要正常签名的模拟器构建。

## 验证

每步之后：`pnpm check`、`pnpm test`、`pnpm bundle`。1、5、6、7 需要 iOS 模拟器构建。

行为验收（真实账号数据，模拟器）：

- 一段含读文件、编辑、执行命令的真实转录，活动行按连续同类聚合，措辞与 `+N −M` 正确
- 流式回复期间正文平滑追加，贴底时自动跟随，手动上滑后不再被拽回
- 键盘弹出与 interactive dismiss 期间 composer 无跳变
- 点活动行开 sheet，terminal 输出完整可读；sheet 打开期间该 item 仍在追加时，内容会刷新
- agent 请求权限时 sheet 自动弹出；作答后机器继续执行
- 滑掉权限 sheet 不写 outcome，转录留下可点的「等待你的批准」，点回去能作答
- 杀掉 data-runtime 再恢复：不重复发送、不重复作答，UI 以 doc 为准；sheet 若开着，在 session 重新 `live` 前显示加载态而非错误态
- 两台设备同时作答同一权限请求：机器只执行一次；记录此时手机端显示的 outcome 是否与实际采纳一致
- 用真实长会话（含大量 terminal 输出）实测载荷体积，确认与工具输出总量脱钩的判断成立
