# Send while attachments upload

Status: draft
Translation: current

[中文](composer-send-during-upload.zh.md)

## Scenario and scope

In an existing Session, a user presses Enter or Send before attachments finish
uploading. The composer accepts one local send intent, hides and locks its draft,
and shows a spinner. The spinner is labelled “Cancel send”; clicking it cancels that intent and restores the
draft; uploads themselves continue. The top-level new-chat landing keeps its
existing upload blocking behavior. There is no durable background outbox.

## Lifecycle

The existing submission token owns both upload waiting and downstream acceptance.
All selected attachments must become available before dispatch. Upload failure,
scope change, unmount, or a blocking session condition cancels waiting without
sending or clearing the draft. Hiding a mounted Tab or entering share selection
keeps an existing intent alive; visibility only gates new submissions. Closing a
Tab or otherwise unmounting its composer still cancels waiting. An image converted
by the existing uploader into a local file remains the same selected attachment.

Prompt text and references are captured at submission. Attachment membership is
checked again before dispatch; a changed draft must not send a partial selection.
The current committed send handler resolves busy state, unfinished assistant turn,
steer support, and run configuration at dispatch time. The current Role accompanies
that configuration. The shortcut's invert flag is retained, but the busy-send
preference itself is read at dispatch time. Run configuration and preferences
are not frozen at the initial keypress. Configuration controls (including Role)
are unavailable from submission through acceptance; cancelling or completing the
submission restores them. This prevents edits through this composer, without
freezing external configuration updates or the live routing state.

An explicit UI phase distinguishes upload waiting from dispatching. Readiness
removes the actionable Cancel send button before downstream acceptance, even when
acceptance remains pending. Once dispatch starts, the Send button is disabled.

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

- [Session composer](../packages/components/src/components/sessions/session-chat-input-area.tsx)
  owns the wait; the parent supplies visibility, including share-selection hiding.
- [Submission tests](../packages/components/tests/session-chat-input-submission.test.tsx)
  cover lifecycle and draft boundaries with controlled upload and acceptance promises.
- [Browser tests](../packages/components/tests/e2e/composer-submission-focus.spec.ts)
  exercise real keyboard input and XMLHttpRequest upload handling against intercepted
  responses in the real composer Storybook surface. The downstream send callback is simulated.
- Tests do not establish daemon delivery or physical native-device behavior.
  Upload waits are memory-only and have no restart recovery.
