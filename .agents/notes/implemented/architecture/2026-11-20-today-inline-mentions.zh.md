# Today 会话引用：节点文本中一个带标记的字符

Status: implemented
Translation: current

[English](2026-11-20-today-inline-mentions.md)

## 摘要

Today 原先用整行节点类型（节点数据里的 `sessionId`）引用会话，引用前后不能写字。owner 要求引用能嵌在句子里，因此现在每个引用是节点 `LoroText` 里的一个 U+FFFC 字符，带 `mention = {kind, id}` 标记，`expand: 'none'`；整行类型已删除（Today 数据尚未发布）。这种格式在并发编辑、撤销和跨节点移动中保持引用原子，代价是所有读写节点文本的地方都必须走富文本辅助函数，不能再用 `toString()` 切字符串。

## 决定

- 引用恰好是一个带 `mention` 标记的 U+FFFC；`readTodayText` 和 `insertTodayRich`（`packages/shared/src/today-outline.ts`）是唯一的读写入口。拆分、合并、粘贴都用它们搬运富文本，不搬纯字符串。
- 写入方在打标记前调用 `configureTodayTextStyles`（`openTodayOutline` 内已调用）：未配置样式时 Loro 拒绝打标记。没有配置的远端也能正确合并，因为 `expand` 随每个标记操作传播。
- 读取时按字符拆分 delta：同一会话的两个相邻引用会合并成一个 span。其他字符上的标记被忽略；没有标记的 U+FFFC 读作占位（`kind: ''`），不会被写回成标记。
- Lexical 绑定按“字符和引用”逐位比较富文本，所以删除两个相邻引用中的一个、或原地替换引用时，写入的 splice 是对的。
- 纯文本（复制、转为任务的提示词）写成 `[@标题](lody://session/<id>?workspace=<id>)`；剪贴板载荷为 `v: 2`，带引用，仍能读取 `v: 1` 的会话行。

## 备选方案

- 给标题文字打标记：别人并发往标题中间插字会继承标记，部分删除会留下半个引用，存下的标题也会过时。
- 单独存一个区间列表：每次编辑都要手动平移偏移量，与 Loro 的并发合并和撤销都对不上。
- 存链接文本：不是原子的，长度可变，并发编辑能把它拆开。

## 影响

每个引用两侧各只有一个光标位置（Lexical 的 `MentionDecoratorNode` 文本就是 U+FFFC），偏移量无需换算。在 loro-crdt 1.17 上实测：撤销会连字符带标记一起恢复；一端删除引用、另一端同时在其后打字，合并后没有残留；`sliceDelta`/`applyDelta` 会带上属性。

## 验证

`packages/shared/tests/today-outline.test.ts`（拆分、合并、粘贴、相邻引用、未配置的远端、并发删除、撤销），`packages/components/tests/today-editor.test.ts`（富文本绑定、引用按键），`packages/components/tests/today-block-selection.test.ts`（剪贴板 v1/v2、链接），以及 `Today/With conversations` story。未验证：在 WebKit 中于选中的引用上或紧挨其前开始输入法输入。
