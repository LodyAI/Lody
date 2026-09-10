# Keep a session's agent context across an expired provider credential

Status: implemented
Translation: current

[中文](2026-09-09-oauth-expiry-context-loss.zh.md)

## Abstract

A single expired provider OAuth credential could permanently detach a session
from its agent transcript: the failing turn force-killed the ACP process without
`session/close`, the next turn's `loadSession` then failed, and the fallback
created a fresh ACP session whose id overwrote `meta.acpSessionId`. Because that
fallback read history from the local mirror without waiting for sync, a machine
whose daemon had just restarted replayed nothing at all and the agent answered as
if the conversation never happened — silently, since the replay notice is skipped
when there is nothing to replay. Authentication failures now close the session
gracefully, are recognised through the `[ACP_RESUME_FAILED]` wrapper so they ask
for sign-in instead of burning the resume pointer, and the fallback refuses to
start a context-free session rather than degrading without saying so. The refusal
fails the turn, which is a visible regression for anyone whose history genuinely
cannot sync; that is deliberate, because the alternative is undetectable.

## The chain, and where each link is cut

The four defects compose; fixing any one alone still loses context.

1. `handleTurnError` terminated with `force = true` for every terminating ACP
   error. `Session.terminate` skips `agentClient.closeSession()` when forced, so
   an adapter that flushes its transcript on close loses the artifact
   `loadSession` needs. Auth failures leave a healthy process behind and now
   terminate gracefully; every other terminating error still forces, because a
   disposed connection only stalls on a graceful close.
2. `isAuthenticationRequiredACPError` matched only the outer error and only
   provider text that named the remedy ("please run /login"). A bare
   "OAuth session expired" fell through to `acp_internal_error`, and the restore
   path saw the wrapped `[ACP_RESUME_FAILED] …` rather than the auth cause
   underneath. It now walks the `cause` chain and accepts expired-credential text
   that names an auth noun; unrelated expiries (certificates, trials, caches)
   stay out, which the tests pin from both sides. The diagnostic match runs per
   chain link rather than once over a flattened dump: the SDK rejects with
   `RequestError`, an `Error` subclass, and `formatErrorWithCauses` prints only
   the message of a nested `Error` — dropping the `data.details` that carries the
   provider's text. A first version of this fix matched the flattened dump and
   was caught in review; its tests passed only because they used a plain-object
   `cause`, which `JSON.stringify` renders with `data` intact. Fixtures now use
   the SDK type.
3. The restore fallback ran on any resume failure. An expired credential is
   recoverable — the transcript is still on disk and `loadSession` works once the
   user signs back in — so falling back replaced a session that only needed a
   login. The fallback is now skipped when the failure is an auth failure, and
   the halt reports `acp_auth_required` so the client offers its sign-in panel.
4. The fallback built its replay from `SessionDocument.getHistory`, a local
   mirror read that never blocks on sync, and created the replacement session
   first. `waitForReplayableHistory` now waits (bounded, on the mirror
   subscription) for an entry other than the current turn, the replay is built
   before the replacement exists, and an empty replay halts the turn instead of
   persisting a new `acpSessionId` over the one that still points at the
   transcript.

## Alternatives and what was left undone

Recording a `previousAcpSessionId` in `SessionMeta` would let a later turn retry
the original transcript after a fallback. It was rejected here as a wire-format
change that the narrower auth fix makes unnecessary for this defect; a genuine
resume failure with synced history still replaces the session, and that remains
the correct outcome.

The `create` dispatch branch (`resolveSessionDispatchAction`) has no history
replay at all, unlike `restoreMissingSession`. It is deliberately unchanged: it is
reachable only when `meta.acpSessionId` was never written, so there is no agent
context to lose, and routing those sessions to `continue` instead would skip the
worktree preparation that only the create path performs. The one reachable
context-losing case there is an imported session in `sync_conflict`, which belongs
to the local-project history feature rather than to this defect.

The replay itself stays lossy by design: it is capped at 100k characters and drops
terminal output, then thinking, then the oldest turns. This note does not change
that; it only guarantees the fallback is not entered with nothing to say.

The "never swap a resumable ACP session for a context-free one" rule is NOT in
`apps/cli/src/session/AGENTS.md`, where it belongs: that file sits 14 bytes below
its 8192-byte gate, and the shortest wording costs about 135. Adding it needs a
topic routed out of that file first, which is a separate change; until then this
note is the only written record of the rule.

## Verification

`apps/cli` unit tests cover each link: the classifier accepts bare expired-
credential text and sees through the resume wrapper while rejecting unrelated
expiries; a turn failing on `OAuth session expired` records `acp_auth_required`
and terminates with `force = false`; a resume failure wrapping an auth cause
halts without a second `createSession`; an unsynced history refuses the
context-free fallback; and late-arriving history is awaited through a mirror
subscription and reaches the prompt as replay text. The late-sync test drives the
subscription from a microtask, so it asserts the signal rather than a sleep.

Not verified: no real provider credential was expired against a live adapter, so
which adapters actually lose their transcript on `SIGKILL` — the premise for the
graceful close — is inferred from the ACP contract rather than measured. The
15s history-sync bound is a judgement, not a measurement.
