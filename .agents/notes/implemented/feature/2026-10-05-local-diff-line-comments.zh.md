# 本地 diff 行评论随下一条聊天消息发送

Status: implemented
Translation: current

[English](2026-10-05-local-diff-line-comments.md)

## 摘要

以前 Changes 面板只有在会话关联了 GitHub pull request 时才显示行评论的 `+` 按钮，草稿也只能发布到
GitHub。在 pull request 出现之前审查 agent 改动的用户，只能手动把路径和行号抄进输入框。现在只要
diff 面板所在界面能发送到聊天，就会启用行评论；草稿会向输入框添加一个 `source: 'lody'` 的评论引用，
由现有管线随下一条消息发送。本地评论发送后不会留在 diff 上，输入框胶囊和对话卡片是唯一的记录。

## 决策与依据

- 当存在 `onSendToChat` 或关联了 pull request 时启用评论
  （[diff 面板](../../../../packages/components/src/components/sessions/session-conversation-diff-panel.tsx)）。
  没有新增能力开关：界面能发送到聊天，正好就是本地评论有去处的条件。
- 草稿自己构造引用
  （[草稿](../../../../packages/components/src/ui/diff-viewer/session-comment-draft.tsx)），
  复用 `DiffViewerCommentCallbacks.onSendToChat`，不新增回调或 payload 类型。
  `CommentReferencePayload` 本来就允许 `source: 'lody'`，输入框胶囊、对话卡片和 CLI prompt 格式化也都已支持。
- 每个本地引用带一个随机 `threadId`。输入框按 `getCommentReferenceKey` 去重，而该 key 包含 `threadId`；
  没有它，同一行上的第二条评论会被静默丢弃。
- 关联 pull request 时，主操作仍是“评论”（发布到 GitHub，原本就会把 GitHub 引用加入聊天），
  “添加到聊天”作为旁边的次要操作。没有 pull request 时，“添加到聊天”是主操作，也对应 Ctrl+Enter。
- 如果输入框拒绝引用（例如会话已归档），草稿保持打开并保留文本。

## 取舍与限制

- 启用评论时 `DiffViewer` 会跳过预渲染 HTML。面板本来就向每个文件的查看器传入 `cachePrerenderedHtml={false}`，
  所以这次没有让面板失去正在使用的缓存。新增的是行事件和 annotation 渲染开销；语法高亮仍走共享
  worker pool。大 diff 的耗时尚未实测。
- 本地评论不会作为线程持久化在 diff 上。这需要在会话文档中存储，属于另一项设计。
- 点击输入框里的本地评论胶囊会打开对应文件，但不会滚动到该行：面板只转发 GitHub 的定位目标。
  对话卡片没有跳转行为。
- 如果在消息等待接受时又添加了评论，接受成功后只移除已提交的引用对象，新评论留给下一轮；
  失败时保留全部引用。以前按整个数组比较，新引用让数组变化后，已接受的评论会留在输入框并被重复发送。

## 验证

- 行为测试覆盖本地与 GitHub 两种操作、快捷键、匿名作者的文件锚点、拒绝、GitHub 写入等待、
  两种 diff 模式、移动端点按行、无聊天回调的界面、跨文件胶囊、移除、已归档输入框，以及接受竞态。
  引用标识的 fixture 使用确定的 UUID。
- 所属测试套件为 `session-comment-draft.test.tsx`、`diff-viewer-render-worker.test.tsx` 和
  `session-chat-input-submission.test.tsx`。存储和 CLI prompt 格式化不新增测试：已有测试已经存储过
  `source: 'lody'` 引用，格式化函数也不读取 `source`。
- 接受竞态的测试在修复输入框之前失败，修复之后通过。
- 在没有关联 pull request 的合成项目上做了真实桌面验证：“添加到聊天”和 Ctrl+Enter 都会附加评论并关闭草稿；
  同一行的两条评论保持为两个胶囊；跨文件胶囊和移除胶囊正常；已发送的 turn 只显示保留下来的评论卡片；
  provider 收到的引用正文一致，且不包含被移除的那条；发送后输入框清空，下一条消息不带引用。
- 关联 GitHub 的操作、已归档输入框的拒绝以及接受竞态只有自动化测试覆盖；没有做真实的 GitHub 写入。
- Issue：[#1225](https://github.com/LodyAI/Lody/issues/1225)。
