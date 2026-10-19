# Session start failures name their step and keep their cause

Status: implemented
Translation: current

[中文](2026-10-16-session-start-failure-attribution.zh.md)

## Abstract

A restored Session failed with `Failed to restore session for chat: ` followed by
nothing, so neither the user nor the daemon log could say what had broken. Three gaps
combined. The thrown error was an Effect tagged error whose message is empty.
Session start never recorded which step it was in. And a failed start's cleanup could
replace the original error with its own. Session start now reports each step as it
begins, and the turn records the step and names it in the failure. An error without a
message is described by its type and cause. Cleanup failures are logged without
replacing the error that callers classify. The original error object is still passed
through unchanged, because callers choose sign-in, history replay or a generic failure
by its identity. Wrapping it would have broken those choices.

## Problem

On 2026-10-16 one daemon recorded three start failures. A new Session showed
`turn_pre_prompt_failed`, and a restored one showed `session_restore_failed` with an
empty reason. Only the create path happens to log a stack. That stack pointed at
`squashFileLockFailure` inside `createWorktree`. The restore path logs the message
alone, so the matching restore failure could only be attributed to the same step from
its timing: no log line between `Worktree already exists` and the failure, 14 seconds
later. [File-lock holder release](../architecture/2026-10-16-file-lock-holder-release.md)
fixes that particular cause. This note covers why the cause was invisible.

- `formatErrorMessage` returned `error.message`, and a `Data.TaggedError` with no
  message getter has `message === ""`. About twenty such classes exist in the CLI and
  shared packages.
- `SessionManager.createSessionInnerWithAgent` runs credentials, working directory,
  worktree, Git identity, runtime resolution and agent start in one Promise. No step
  was recorded, so a failure could not name where it occurred.
- Its catch blocks awaited `session.terminate()` and `credentials.release()` before
  rethrowing. A failure in either replaced the original error.

## Decision

- `SessionConfig.onStartStage` receives `credentials`, `workdir`, `worktree`,
  `git-identity`, `agent-runtime` and `agent-start` as each begins, and each is
  logged at debug. The execution service stores the last step on the turn's runtime
  state, for that exact turn only, and clears it when a Session is bound. A later
  pre-prompt failure therefore is not attributed to start-up.
- `session_restore_failed`, its history-replay fallback and `turn_pre_prompt_failed`
  record `<step> failed: <message>`. Authentication failures keep their own message,
  because the client uses it to offer sign-in. The restore log line now also carries
  the error object, so its stack is logged.
- Failure text uses the new `formatReportedError`. It describes an error with an
  empty message as its `_tag` or `name`, followed by its cause, and only an Error or
  string cause is described, because the text reaches synced chat history.
  `formatErrorMessage` itself is unchanged: worktree recovery and the restore path's
  `acp_resume_failed` detection substring-match its output, and making it never empty
  would let a cause's text change those decisions.
- Failed-start cleanup always runs to the end and logs each failure with its causes.
  The original error is rethrown. This follows the existing `createAgent` failure
  branch.

## Alternatives

- **Wrap failures in a `SessionStartFailed { stage, cause }` error.** Rejected.
  Restore checks `AcpAuthenticationRequiredError` and the `acp_resume_failed` text,
  and create checks ACP and disconnection shapes and missing Git. Each of these would
  need to unwrap, and any it missed would silently send authentication or resume
  failures down the generic path.
- **Give every tagged error a message.** Necessary but not sufficient. #1614 did this
  for file locks, but any future class without one would bring back the empty
  reason. The formatter fallback covers all of them at the reporting boundary.
- **Trace spans per step.** Not added. Debug lines at each step boundary already
  timestamp every transition, and a span would also need a separate end event.

## Limits

- Step attribution covers `SessionManager.createSession` only. Pre-prompt work in
  the execution service (memory pressure, access, configuration) keeps its existing
  messages.
- An unresolved release logged by cleanup is not retained for retry here. That
  remains with the owning lease, for example the credential broker's scope.
- Step names are English text inside the failure message, like the other pre-prompt
  failure messages. They are not localized.

## Verification

`tests/session-execution-service.test.ts` exercises the real restore and create
boundaries. A mocked `createSession` reports `worktree` and then throws a tagged error
whose message is empty. Both paths record `Preparing the worktree failed:
MessagelessStartFailure: <cause>`. An authentication failure reported during
`agent-start` still records `Authentication required`. Removing the formatter fallback
makes the restore case record exactly the production symptom: `Preparing the worktree
failed: ` followed by nothing. Existing cases without a reported step keep their old
messages.

Later change: the retry decision added a `worktree-setup` step, reported when the setup
script starts. See [transient retry](../feature/2026-10-16-session-start-transient-retry.md).
