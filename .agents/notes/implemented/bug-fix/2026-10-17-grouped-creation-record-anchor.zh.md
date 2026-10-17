# 阅读锚点所在的创建记录被分组后仍能找到

Status: implemented
Translation: current

[English](2026-10-17-grouped-creation-record-anchor.md)

## 摘要

读者停在"创建会话"卡片上时，对话页可能以 `ConversationScrollUpdateLoopError` 崩溃。连续的创建记录只有在第一条记录已加载时，才会以第一条的 key 合并成一行；而加载窗口跟随上报的滚动位置移动。分组让锚点记录自己的行消失后，锚点解析不知道这一行仍包含它，退回到很远的轮次；新位置移动了加载窗口，使记录重新拆出，又回到原位置。现在分组行会列出它包含的轮次，解析会落到包含该记录的行，第二种状态因此稳定。生产中兜底为何落到约 9000px 外尚未查明。

## 证据

崩溃会话的引擎诊断每次 commit 都在两种结果间交替，全部是 `movement=none`、一次事务、视口已覆盖：

- `resolvedKey` 等于锚点的 `operation-progress:…` key，目标 14347；
- `resolvedKey` 是无关的 `…:worked-header` 行，目标 5336。

锚点一直没变，所以是行列表本身在两种形态之间翻转。每次翻转都是滚动器布局 effect 里的一次同步 commit，经 `onScroll` → `reportVisibleTurnRange` → `setVisibleRange`，直到 24 次 commit 的[更新循环保护](2026-10-13-scroll-update-loop-guard.zh.md)中止。主动重试恢复同一锚点，循环重演。

形态变化来自 `buildChatVirtualRows`：连续的纯创建记录以第一条的 key 合并，遇到未加载的轮次就断开分组（见[创建会话列表](../feature/2026-10-11-created-session-list.zh.md)）。循环要求锚点记录之前的那条记录 X 位于加载窗口上沿附近：

1. X 是占位行，锚点记录自成一行，锚点解析成功。
2. 上报的位置让窗口包含 X；X 已在内存中，同一次渲染就加载完成。X 成为组头，组内包含锚点记录。
3. `resolveAnchor` 只按 `turnId` 匹配行，而该值是组头的。没有规则找到锚点轮次，于是"轮次已删除"的兜底选了另一个轮次。
4. 新位置让窗口离开 X，X 变回占位行，回到第 1 步。

## 决定

`EngineRow.groupTurnIds` 列出一行额外渲染的轮次，由 `view.tsx` 从 `groupedItems` 填入。`resolveAnchor` 在同轮次规则之后、轮次删除兜底之前检查它，落到包含行的偏移 0 处。第 3 步时读者停在该组，上报的区间让 X 留在窗口内，分组形态保持不变。

偏移 0 会丢掉读者在记录内的位置。引擎不知道卡片在组内列表中的位置，组顶最多比它高几行紧凑行。分组结束时，规则 1 仍会返回记录自己的行。

考虑过的替代方案：

- 关闭分组能消除这个循环，但会让创建会话列表退化，且其他 key 随加载变化的行仍可能同样循环。
- 让整串创建记录一起加载能在本例中保持 key 稳定，但解析在消息选择等其他行变化中仍看不到被分组的轮次。
- 把加载更新移出同步链只会让翻转变慢，锚点仍在两个位置间交替。

## 验证与限制

`tests/conversation-scroll-engine.test.ts` 中的模型测试把每次上报的位置反馈到行形态，c0/c1 是否分组由窗口决定。没有新解析规则时它抛出 `ConversationScrollUpdateLoopError`，有规则时 c0 稳定在视口顶部。测试中的锚点带有过期的轮次序号，使兜底像生产中一样落到远处。生产中的轮次序号是否会过期，或兜底因其他原因落得很远，尚未查明；轮次删除规则仍依赖 `turnIndex`。
