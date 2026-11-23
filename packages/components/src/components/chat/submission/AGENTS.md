# Composer submission lifecycle

`CLAUDE.md` is a symlink to this file. Parent guidelines also apply.

- `useComposerSubmission` owns one in-flight submission per mounted scope and the
  post-commit focus handoff. Mobile input stays focused while pending; accepted
  sends dismiss after the message surface paints. Completion is an explicit
  transition, even when pending and completion batch into one render.
- Scope changes and unmount retire submissions. Late completion must not unlock,
  clear, or focus a newer composer. Draft persistence stays with the caller.
- The scope's submission token owns both lifetime identity and the synchronous
  submission lock; do not mirror it with independent active/finished flags.
- Focus ownership ends when the user focuses/clicks elsewhere or leaves the window;
  returning focus to body does not renew that ownership. No timers or focus retries.
- Observe focus and pointer changes in capture phase so child event propagation
  cannot hide a focus handoff. Native focus eligibility belongs to the browser.
- Consumers keep the input DOM stable when clearing its value. Mention data and
  hydration reset independently of the textarea; only a draft identity change may
  remount the mention tree. Verify submission with the real composer, not a textarea mock.
- On mobile, transient pending state blocks edits without disabling the textarea
  or changing its identity. Archived fields remain disabled. Pending submission
  text is a controlled render value; do not clear the DOM imperatively while
  retaining the draft for rejection recovery.
- Creating a session hands focus across navigation through a one-shot
  history-state request, claimed by the visible target composer after mounting.
  Consume it from history before focusing; ordinary visits, remounts, and Back
  must not replay the handoff. Never guess readiness with a timeout.
- Automatic composer focus is desktop-only. Narrow mobile layouts and native
  shells (including wide iPads) must not focus on entry or submission completion,
  whether the submission succeeds or fails. First-send may transfer an existing
  new-chat focus to the mounted destination before removing the source. On native
  iOS, require the native keyboard-height signal too; a hide can retain DOM focus.
  After a committed frame, dismiss only the still-owned input; key, input,
  composition, pointer, focus/window changes or scope teardown cancel this work.
  Rejection keeps editing available. Explicit user focus actions still work.

- Attachment waits share the submission token through acceptance. Recheck its
  lifetime after readiness; resolve routing from the current committed callback.
  Visibility gates new intents; hiding a mounted composer preserves existing waits.
  Render upload-wait versus dispatching actions from explicit state, never a mutable ref.
  Disable composer config controls through acceptance; clear only unchanged draft fields.
