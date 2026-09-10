# Conversation context copy and editable text attachments

Status: draft
Translation: pending

## Scenario

A user wants to continue a conversation with a different Agent, model, machine,
or workspace, including when the source ACP provider cannot fork. Copying a
readable history prefix provides a manual handoff without transferring provider
session state or project files.

## Copy boundary

Every user and assistant message exposes a fork menu with Copy context as Markdown.
Native fork destinations retain their capability and completion restrictions;
copying is independent of those restrictions. Copy includes the selected message
and all preceding history, never subsequent messages. The session menu copies all
history. A missing selected message fails visibly rather than expanding the range.
A generating response is copied as a point-in-time partial response and marked so.

User and assistant prose remain complete. Existing Markdown export budgets may
reduce tool details, with an explicit notice. Attachment names and image counts
are included with a notice that their bytes are not copied. No file migration,
provider state transfer, or automatic target-session creation is implied.

## Editable text attachments

A single paste of more than 5000 normalized JavaScript string characters becomes
an inline text-file draft. At or below the threshold it stays ordinary text.
Typing and accumulated short pastes do not trigger conversion. There is no separate
1024-character folding tier. Line endings normalize to LF; surrounding whitespace
is preserved. The threshold is a UI rule, not a model token-budget guarantee.

Clicking the draft opens its editor. Edits stay in the draft; reducing its size
never automatically converts it to prose. Users may copy its contents, remove it,
or restore it as message text. The composer add menu can turn ordinary message
text into a file even below the threshold. The same editing surface applies to
new sessions, existing sessions and side chats, and pasted content in edit/resend.
Conversion, editing and removal update committed mention ranges with the same
text edit. Mentions inside replaced prose stop carrying session context; mentions
outside the edit keep their identity at their new offsets.

On send, the current draft bytes become a plain-text file using existing attachment
transport. Same-machine Electron handoff stays local; optional cloud transport is
available only with cloud-sync capability. Transfer failure preserves the draft
and prevents submission. Attachments count toward the existing per-message file
limit. Submitted history files are immutable through the draft editor.

## Sending feedback

Sending a new conversation with text-file drafts navigates immediately to its
reserved session route. Until the files have uploaded and passed verification,
that route renders a client-local pending message with its text, current file,
transfer phase and byte progress, explicitly labeled as not sent. Existing
conversation composers show the same pending feedback above the input.

The pending route does not create an empty durable session, append a user turn,
or dispatch an Agent request. Upload completion is followed by the existing atomic
session-and-first-turn acceptance. The UI distinguishes uploading, verification,
and submitting; upload completion alone is never presented as message delivery.

Upload failure retains the draft and offers Retry upload or Return to edit.
Retry never retries session acceptance; an acceptance failure requires returning
to edit. Returning to edit during an upload aborts the cloud transfer and prevents
late results from submitting a message. Local IPC transfers cannot be interrupted,
but their late results are discarded. Route changes do not own the new-session
upload lifetime. The selected account, workspace and submitted input remain frozen;
a changed account or active workspace prevents acceptance.

The landing keeps one pending upload submission per user because its prompt draft
is user-scoped. Returning to the landing exposes a link to the pending route. This
state is in memory only, like the existing attachment drafts; it does not survive
reload or app restart and does not imply cross-device upload progress. Edit/resend
retains its existing editor submission feedback.

The receiving CLI materializes ordinary file blocks beneath the execution
workspace's `.lody/attachments/` and supplies ACP `resource_link` blocks with
`file://` URIs. It does not inline the text. Agents may subsequently read the file;
this does not guarantee that later reads stay within a particular context budget.

## Remaining transport limit

This change reuses ordinary file-block protocol without adding versioned fields.
The existing CLI's later download failure behavior still reports an unavailable
attachment to the Agent. Blocking dispatch on that failure is a separate protocol
and lifecycle decision; renderer upload failure already blocks submission.

## Evidence

- [Copy range](../packages/components/src/lib/conversation-copy-range.ts)
- [Draft operations](../packages/components/src/lib/pasted-text-draft.ts)
- [Submission transport](../packages/components/src/hooks/use-pasted-text-attachments.ts)
- [CLI materialization](../apps/cli/src/lib/message-handler.ts)
