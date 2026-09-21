# Send while attachments upload

Status: draft
Translation: current

[中文](composer-send-during-upload.zh.md)

The behavior below is proposed and exists only in an
[isolated POC](../packages/components/poc/send-during-upload/README.md).
Production sources retain their existing upload blocking behavior.

## Scenario and scope

In an existing Session, a user presses Enter or Send before attachments finish
uploading. The composer accepts one local send intent, hides and locks its draft,
and shows a spinner. Clicking the spinner cancels that intent and restores the
draft; uploads themselves continue. This proof of concept does not change the
new-chat landing or introduce a durable background outbox.

## Lifecycle

The existing submission token owns both upload waiting and downstream acceptance.
All selected attachments must become available before dispatch. Upload failure,
loss of visibility, scope change, unmount, or a blocking session condition cancels
waiting without sending or clearing the draft. A hidden mounted Tab counts as
leaving the composer. Returning does not resume an old intent. An image converted
by the existing uploader into a local file remains the same selected attachment.

Prompt text and references are captured at submission. Attachment membership is
checked again before dispatch; a changed draft must not send a partial selection.
The current committed send handler resolves busy state, unfinished assistant turn,
steer support, and run configuration at dispatch time. The current Role accompanies
that configuration. The shortcut's invert flag is retained, but the busy-send
preference itself is read at dispatch time. This POC does not freeze run configuration
or preferences at the initial keypress.

Only downstream acceptance retires submitted draft fields that still match their
captured versions; newer text, attachments, or references from external actions
must survive an old acceptance. Rejection restores text and uploaded attachments.
Repeated Enter cannot create another intent while the token is active. Hidden
composers also reject new submission events. Readiness does not outlive its token:
a scope retired during the ready commit cannot dispatch from its queued continuation.
Already failed ordinary files are excluded from this intent and cannot cancel its
wait. A newly selected file failing during waiting cancels automatic sending.
Preparing, uploading, and verifying files all remain blocking until fully uploaded.

## Evidence and limits

- [POC runner and scope](../packages/components/poc/send-during-upload/README.md).
- [Experimental patch](../packages/components/poc/send-during-upload/prototype.patch)
  applies the implementation and its real-composer tests only inside a temporary
  checkout. Uploads and downstream acceptance are controlled test boundaries; the
  existing route resolver is exercised for Send, Steer, and Queue.
- These tests do not establish daemon delivery, real network behavior, or installed
  Electron behavior. Upload waits are memory-only and have no restart recovery.
