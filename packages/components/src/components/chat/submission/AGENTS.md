# Composer submission lifecycle

`CLAUDE.md` is a symlink to this file. Parent guidelines also apply.

- `useComposerSubmission` owns one in-flight submission per mounted scope, immediate
  mobile blur, and the post-commit focus handoff. Completion is an explicit state
  transition, even when pending and completion batch into one render.
- Scope changes and unmount retire submissions. Late completion must not unlock,
  clear, or focus a newer composer. Draft persistence stays with the caller.
- Focus ownership ends when the user focuses/clicks elsewhere or leaves the window;
  returning focus to body does not renew that ownership. No timers or focus retries.
- Consumers keep the input DOM stable when clearing its value. Mention data and
  hydration reset independently of the textarea; only a draft identity change may
  remount the mention tree. Verify submission with the real composer, not a textarea mock.
