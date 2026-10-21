# 把对话中选中的文字引用进输入框

Status: proposed
Translation: current

[English](2026-10-21-conversation-selection-quote.md)

## 摘要

在对话消息里选中一段文字再对它提问，目前只能手动复制，复制之后就丢失了它来自哪条消息。
本提案捕获不可变对话行上的原生选区，并沿用文档选区已有的路径，把它作为普通的大段粘贴
文本 chip 放进输入框草稿，而不是新增一种 `SessionInputBlock`。引用是这段文字的**快照**，
因此无法跟随之后对原消息的编辑；属于其他对话面板、或超过长度上限的选区会被忽略。实现随本
笔记一并提交，等待评审；它在本地通过仓库级检查，iOS / Safari 长按的选择时序仍未验证。

## 问题

想针对长回答中的某一段提问，必须选中、复制、再粘贴到输入框，这既丢掉了它与消息的关联，
也让 agent 看不出这段文字的出处。Trae 和 ChatGPT 都提供了「选中后批注」的流程，让引文
和问题保持在一起。

仓库里没有任何东西覆盖对话正文：issue
[#1225](https://github.com/LodyAI/Lody/issues/1225) 及其 PR 覆盖的是 **diff 行**批注，
其锚点是 `path`/`lineNumber`/`side`，无法描述对话正文。`use-conversation-text-selection.ts`
已经把原生选区映射到 turn id（用于保留对应的行），但它不暴露 Range、文本或位置，也不驱动
任何 UI。

## 决定

在新的、面板局部的 hook 中捕获选区，并把正文作为文本暂存，与文档选区的做法一致：

- `lib/conversation-selection-quote.ts` 负责快照结构、长度上限和提示词文本
  （`Message selection` / `Selected content:` / `> …`），与 `formatDocumentSelection` 对齐。
- `components/ai-gui/selection-quote.tsx` 负责捕获（`useSelectionQuote`）和输入框上方的
  操作条（`SelectionQuoteBar`）。
- `session-chat-input-area.tsx` 暴露 `addSelectionQuote`，复用
  `insertLargePastedTextAtSelection` —— 与 `addDocumentSelection` 完全相同的调用 ——
  引用因此成为一个普通的粘贴文本 chip：标签就是引文本身，正文在发送时展开。不新增输入块
  类型，也不改 wire 或存储格式。chip 标签带方括号（`[引文…]`），因为这种 chip 会把图标画在
  开头的 `figure space + [` 上、并让结尾的 `] + figure space` 留空 —— 也就是
  `[Pasted 4,182 chars]` 所支付的那两个槽位；标签若不自带分隔符，引文自己的首尾字符就会被
  吃掉。

归属由 turn id 判定：行的 `data-conversation-turn-id` 必须能在该面板自己的
`ConversationView` 中解析出来。因此当侧边对话和主对话同时挂载时，任何一方都无法捕获另一方
的选区。

捕获是**刻意粘滞**的：光标折叠不会撤销引用，而在操作条之外按下指针会。这样做的原因是浏览器
在 `pointerdown` 时拆除原生选区的顺序并不固定（手机上的系统长按尤其如此），如果捕获跟着
实时选区走，它可能在「按下」与「本该确认它的 click」之间消失。

## 备选方案

**新增一种 `SessionInputBlock`。** `comment_reference` 和 `visual_annotation_reference` 已
存在，形状是现成的。放弃的原因是成本：该 union 在 `packages/shared` 与 `apps/cli` 中有
四十多个触点，而编译器只强制其中两处（`session-input.ts`、`message-handler.ts`）。其余都
是静默失败 —— replay 丢弃该块、Markdown 导出丢失它、严格的 schema 会把整个块列表降级成
纯文本。这远超社区贡献 1000 行的上限，而且会把一个未经评审的持久格式放进共享历史。

**可重新解析消息的锚点**（diff 批注采用的形式）。它能挺过编辑，也能渲染成真正的引用 chip。
但它需要一份持久锚点契约 —— 被引用的 turn 被折叠、删除或重新流式输出时怎么办 —— 这是 Spec
量级的决定，不是裁剪。因此推迟；快照形式不会挡住它，因为无论哪种形式，chip 都是普通的输入框
文本。

**扩展系统选择菜单。** 在本仓库内不可达：WKWebView 的自定义菜单需要宿主 shell 代码，而它
不在本仓库中。

## 范围与限制

- 所有平台共用输入框上方的一条操作条。触摸端无法复用长按手势（它属于系统选择），因此操作条
  就是手机用户确认引用的位置；其控件在窄屏保持默认按钮尺寸。
- 只有不可变历史行内的正文可被引用。本地的（尚未权威的）行、以及对话行之外的文字会被忽略；
  超过 50,000 字符的选区同样被忽略 —— 此时不显示该动作，而不是静默截断。
- 一次草稿可以暂存多条引用，每条各成一个 chip，用户自己的批注是它们之间普通的输入框文本。
- 引用是快照：之后编辑原消息不会改变已发送的内容，也不存在从已发送消息回到被引用 turn 的链接。
- 实现时发现、但为控制本次改动范围而**未**一并修复：同一个机制在隔壁的调用点也是错的。
  `addDocumentSelection` 传入的标签没有分隔符（`report.pdf · p.3`），因此那个 chip 会盖住
  文件名首字符、并隐藏末字符。修法就是同一对方括号，它属于那个功能而不是这里。

## 验证限制

- 在撰写用的 checkout 中已验证：仓库级 `pnpm check`（工作区类型检查、两个 linter、完整测试
  套件与全部边界脚本）通过，`pnpm format` 不会改动本次改动集。
  `conversation-selection-quote.test.tsx` 在 jsdom 中覆盖格式契约、归属过滤、粘滞捕获规则、
  关闭动作与交接；加进 `session-chat-input-submission.test.tsx` 的两条用例驱动真实输入框，
  因此 chip 的落位与提交时的展开都被覆盖，而不只是格式化函数。
- 交互在真实 Chromium 的 Storybook 两个 story 中验证：选中正文会升起操作条，而在其主按钮上的
  真实指针按下 —— 它会在 `click` 到达之前先拆掉原生选区 —— 仍然把格式化后的引用交给草稿。
- 在本地桌面构建中对着真实 agent 走通了端到端流程：在回答上拖选会升起输入框上方的操作条，
  主按钮落下一个以引文为标签的 chip，随后返回的回答正是针对被引用的那一段 —— 说明展开后的
  提示词确实到达了 agent。chip 的图标槽位会盖住自己那对方括号，因此暂存的标签不会丢掉引文的
  任何字符。
- iOS 与 Safari 的选择时序未在真机验证 —— 与
  [原生选区笔记](../../implemented/bug-fix/2026-09-20-conversation-text-selection.md) 记录的
  是同一个缺口。
