# Local diff line comments

Status: draft
Translation: current

[中文](local-diff-line-comments.zh.md)

A user who reviews agent changes in the Changes panel can comment on a diff line
without a linked pull request. The comment becomes a reference chip in the
composer and is sent with the next message, so the agent receives the exact path,
line, and side. The user can add several comments, on one line or across files,
and remove a chip before sending.

Line comments are available when the diff surface can send to chat. With a linked
pull request, "Comment" still posts to GitHub and "Add to chat" stays available as
a local action. A local comment makes no GitHub or hosted request. If the composer
cannot accept the reference, such as in an archived session, the draft stays open
with its text. After the message is accepted, only the sent references leave the
composer.

Local comments are not kept as threads on the diff after sending; the composer
chip and the sent conversation card are the record. Clicking a local chip does
not yet scroll to its line.

Evidence: `packages/components/src/ui/diff-viewer/session-comment-draft.tsx`,
`packages/components/src/components/sessions/session-conversation-diff-panel.tsx`,
and the decision note
[local diff line comments](../.agents/notes/implemented/feature/2026-10-05-local-diff-line-comments.md).
