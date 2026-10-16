# 本地 diff 行评论

Status: draft
Translation: current

[English](local-diff-line-comments.md)

用户在 Changes 面板审查 agent 改动时，不需要关联 pull request 就能对 diff 的某一行发表评论。
评论会成为输入框中的引用胶囊，随下一条消息发送，让 agent 拿到准确的路径、行号和 diff 侧。
用户可以在同一行或不同文件上添加多条评论，并在发送前移除胶囊。

只要 diff 所在界面能发送到聊天，就可以使用行评论。关联 pull request 时，“评论”仍发布到 GitHub，
“添加到聊天”作为本地操作保留。本地评论不会发出 GitHub 或托管服务请求。如果输入框无法接受引用
（例如会话已归档），草稿保持打开并保留文本。消息被接受后，只有已发送的引用会离开输入框。

本地评论发送后不会作为线程保留在 diff 上；输入框胶囊和已发送的对话卡片就是记录。点击本地胶囊
暂时不会滚动到对应的行。

实现依据：`packages/components/src/ui/diff-viewer/session-comment-draft.tsx`、
`packages/components/src/components/sessions/session-conversation-diff-panel.tsx`，以及决策记录
[本地 diff 行评论](../.agents/notes/implemented/feature/2026-10-05-local-diff-line-comments.zh.md)。
