# Send local diff line comments with the next chat message

Status: implemented
Translation: current

[中文](2026-10-05-local-diff-line-comments.zh.md)

## Abstract

The Changes panel showed the line comment `+` button only when the session had
a linked GitHub pull request, and a draft could only be posted to GitHub. Users
who review agent changes before a pull request exists had to copy a path and a
line number into the composer by hand. The diff panel now enables line comments
whenever its surface can send to chat, and the draft adds a `source: 'lody'`
comment reference to the composer, which the existing pipeline sends with the
next message. Local comments are not kept on the diff after they are sent; the
composer chip and the conversation card are the only record.

## Decision and evidence

- Comments are enabled when `onSendToChat` is present or a pull request is
  linked ([diff panel](../../../../packages/components/src/components/sessions/session-conversation-diff-panel.tsx)).
  No new capability flag: a surface that can send to chat is the exact
  condition under which a local comment has a destination.
- The draft builds the reference itself
  ([draft](../../../../packages/components/src/ui/diff-viewer/session-comment-draft.tsx))
  and reuses `DiffViewerCommentCallbacks.onSendToChat`, so no new callback or
  payload type is added. `CommentReferencePayload` already allowed
  `source: 'lody'`, and the composer chip, conversation card, and CLI prompt
  formatter already handle it.
- Each local reference gets a random `threadId`. The composer de-duplicates
  references by `getCommentReferenceKey`, which includes `threadId`; without
  it, a second comment on the same line would be silently dropped.
- With a linked pull request, the primary action stays "Comment" (post to
  GitHub, which already adds the GitHub reference to chat). "Add to chat" is a
  secondary action next to it. Without a pull request, "Add to chat" is the
  primary action and Ctrl+Enter.
- If the composer rejects the reference (for example, an archived session), the
  draft stays open with its text.

## Trade-offs and limits

- `DiffViewer` skips prerendered HTML when comments are enabled. The panel already
  passes `cachePrerenderedHtml={false}` on every file path, so this change does not
  remove an active panel cache. It adds line events and annotation rendering;
  syntax work still uses the shared worker pool. Large-diff timings remain unmeasured.
- Local comments are not persisted as threads on the diff. That needs storage
  in the session document and is a separate design.
- Clicking a local composer chip opens its file, but does not scroll to its line:
  the panel forwards only GitHub focus targets. Conversation cards are inert.
- If a comment is added while a message awaits acceptance, success removes only
  the submitted reference objects. The new comment remains for the next turn;
  failure retains all references. Comparing the whole array left accepted comments
  in the composer and resent them when a new reference changed the array.

## Verification

- Behavioral checks cover local and GitHub actions, keyboard shortcuts, anonymous
  file anchors, rejection, pending GitHub writes, both diff modes, mobile line taps,
  no-chat surfaces, chips across files, removal, archived composers, and the
  acceptance race. The reference identity fixture uses deterministic UUIDs.
- The owning suites are `session-comment-draft.test.tsx`,
  `diff-viewer-render-worker.test.tsx`, and `session-chat-input-submission.test.tsx`.
  Storage and the CLI prompt formatter need no new tests: existing coverage already
  stores a `source: 'lody'` reference, and the formatter does not read `source`.
- The acceptance-race test failed before the composer fix and passed after it.
- A live desktop run on a synthetic project, with no linked pull request,
  confirmed: Add to chat and Ctrl+Enter attach and close the draft; two comments
  on one line stay separate chips; chips across files and chip removal work; the
  sent turn shows exactly the retained comment cards; the provider received the
  retained references with matching bodies and not the removed one; the composer
  clears after sending, and the next message carries no references.
- Linked GitHub actions, archived-composer rejection, and the acceptance race have
  automated coverage only; no live GitHub write was performed.
- Issue: [#1225](https://github.com/LodyAI/Lody/issues/1225).
