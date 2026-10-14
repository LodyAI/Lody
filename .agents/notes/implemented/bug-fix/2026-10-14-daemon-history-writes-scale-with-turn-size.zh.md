# 守护进程写历史的代价随回合大小增长，而不是随改动大小

Status: implemented
Translation: current

[English](2026-10-14-daemon-history-writes-scale-with-turn-size.md)

## 摘要

一个工具调用密集的会话，历史涨到几十 MB 后，CLI 守护进程每次 flush 写入 agent 输出都要在主线程上耗费好几秒。原因是每个工具批次都把整份历史序列化一遍，纯文本批次也要把整个目标回合序列化两遍。主线程被占满后，赶不上 Streams 首次同步的 120 秒期限，本地写入一直传不到其他设备，直到这一波输出结束。现在流式批次改为只写一个窗口：目标回合的字段、它的尾部 item，以及这批要更新的工具 item（不管存在哪个回合）。这些工具 item 通过一个带版本校验的 `toolCallId` 索引定位。在合成的 28 MiB 历史上，单批耗时从 0.5–1.4 秒降到 1–3 毫秒。剩下的代价是：只要有一次写入不是它自己做的，索引就要把历史重扫一遍（这个规模下约 150 毫秒）。

## 根因

`appendACPNotificationsToAssistantEntry` 只有在整批都是纯文本或思考块时才标记 `entryBound`，因为工具更新可能属于更早的回合。其余批次都走 `HistoryWriter.update`：先用 `list.toJSON()` 读出整份历史，生成新数组，再 diff 写回。出事会话的阻塞 profile 采到的正是这条栈：`toJSON` ← `readAll` ← `update` ← `applyAgentBatch`，占包含时间的 67–87%。

把工具批次也改成 entry-bound 并不能解决问题。当一个回合装着对话的大部分内容时，entry-bound 路径反而比全量路径更贵：它先 `read(id)` 再 `updateEntry`，把这个回合序列化两次，之后还要 diff 全部 item。在一个回合里有 16,000 个 item（JSON 28 MiB）的合成历史上测得：

| 批次                          | 修改前    | 修改后 |
| ----------------------------- | --------- | ------ |
| 尾部附近的 `tool_call_update` | 531 ms    | 2.8 ms |
| 新的 `tool_call`              | 558 ms    | 1.7 ms |
| 文本块（entry-bound）         | 1,047 ms  | 0.9 ms |
| 同一回合很靠前的工具调用      | 1,442 ms¹ | 1.1 ms |
| 更早回合里的工具调用          | 531 ms    | 1.2 ms |

¹ 按一个修复提议的做法，把该工具批次强制走 entry-bound 路径。

## 改了什么

- `HistoryWriter.updateTail(turnId, toolCallIds, updater)` 交给共享 planner 一组窗口行。目标行带除 `fileDiff` 外的所有字段，但 item 只有尾部：最后一个 item，并向前延伸跨过相邻的文本/思考 item。每个被引用、但存在尾部之外的工具调用，各自成为一个单 item 行。writer 用局部 map diff 写回改动的字段，用 `diffHistoryListRange` 写回 item 区间，区间外的 item 既不读也不写。和 writer 的其他方法一样，所有内容都在第一次 CRDT 修改之前准备好。
- writer 维护一个 `toolCallId → (行, item)` 索引，只在它记录的文档版本上有效。归属规则与全量 planner 一致：取包含该 id 的最新一行，行内取第一个匹配的 item。writer 在自己的窗口写入和字段写入之后更新索引，因为字段写入不可能新增工具 item。其他任何本地写入或导入的改动，都会让下一次窗口写入重建索引；某个位置上的 id 对不上时也会触发重建。
- `targetLocalToolCallIds` 放在 applier 旁边，用来判断一个批次是否只涉及目标回合：文本、思考、计划和空操作类更新，加上不是子代理任务的工具调用。子代理任务和事件、Devin 子代理内部更新、富内容、单例 item 仍走全量路径。目标行重复或使用内联旧存储时，`updateTail` 返回 false，同样走全量路径。
- entry-bound 回退路径不再在 `updateEntry` 之前先调用 `read(id)`。

## 尾部边界

压缩会合并相邻的同类文本/思考 item，并解析被改动回合里的 `<thinking>` 标签。如果尾部从一个文本/思考 item 开始，而它前面紧挨着另一个，那么解析出来的思考块会留在尾部里，没法和前面已存的思考 item 合并。所以尾部要向前跨过相邻的文本/思考 item。

全量路径还会对被改动回合里的每个文本 item 重新做清理和标签解析，窗口只对尾部做。尾部之前的 item 在上次写入时已经过同样的清理和解析，处于稳定状态。如果某个旧 item 是更早的版本写的、当时没经过这些处理，它会保持存储的原样，直到下次被重写。

## 考虑过的其他方案

- **工具批次也走 entry-bound。** 实测更慢（见上表），而且会把旧回合的工具更新写到当前回合。
- **每批都扫描工具调用，不建索引。** 全量扫描即使只读每个 item 的 `type` 和 `toolCallId`，在这个规模下也要 50–130 毫秒。新的 `tool_call` 要证明它的 id 在全历史里都不存在，所以几乎每个批次都要付这个代价。
- **用文档事件维护索引。** 这样导入之后不用重扫，但要依赖 Loro 如何报告导入过程中新建的容器。版本校验更容易证明索引完整。如果 profile 里出现重扫开销，再重新考虑。
- **Streams 首次同步超时时也上传本地积压。** 这能缩短断联时间，但没有消除原因，而且会改变 `@loro-dev/streams-crdt` 的协议行为，应由该包的维护者决定。

## 验证与局限

`apps/cli/tests/session-history-storage.test.ts` 验证了以下几点：

- **与旧路径结果一致。** 一段脚本化的流式输入，经 `applyAgentBatch` 写入和经原来的全量 `update` 写入，得到的存储历史完全相同。覆盖了文本合并、跨块拆分并与前一个思考块合并的 `<thinking>` 标签、计划、`acpTurnId`，以及位于尾部、目标回合靠前位置、更早回合、只出现在更新里的工具调用。
- **其他写入方。** 另一个写入方先存入一个工具 item，再在它前面插入内容使其位移，之后的更新仍写到这个 item 上，不会产生重复。
- **目标行重复。** 目标行重复时保持全量路径的行为。

去掉尾部延伸、单 item 行、索引版本校验或单 item 行的偏移量中任何一项，都至少会让其中一个测试失败。

表中数字来自单台机器上 Node 里的合成 Loro 数据，应当作比例参考，而不是性能预算。

没有改变的部分：

- 建立索引、以及外部写入后的重建，仍是一次全量扫描。
- 富 `contents` 批次和子代理批次仍走全量历史。
- `operation-progress` 的预览（`readStored`）和 usage 更新的 userId 回退仍读取全量历史。
- 快照导出仍在主线程上（#1455）。

窗口写入是[单一历史写入者](../architecture/2026-09-07-single-history-writer.zh.md)中那个唯一 writer 的一个方法，不是第二条写入路径。渲染端对应的问题见[流式开销随对话长度增长](2026-09-16-streaming-cost-scales-with-conversation-length.zh.md)。
