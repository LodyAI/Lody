# Preserve the turn while replacing a stale ACP instance

Status: implemented
Translation: current

[中文](2026-10-17-stale-acp-recovery-turn-ownership.zh.md)

## Abstract

Stale ACP recovery terminated the registered Session as though its live turn had
ended. The termination callback marked the assistant reply finished and cleared its
output owner; native resume suppression could then discard replacement output.
Recovery now reuses instance retirement, preserving the same turn until the retry
settles. Failed or interrupted retirement keeps the old Session under its existing
release owner; the native presence lease already protects heartbeats.

## Decision and responsibility

This extends the [failed-create lifecycle decision](2026-09-11-failed-session-create-lifecycle-events.md)
to an instance that already prompted. An ordinary user turn still gets at most one
stale-connection/missing-session retry before ACP output. Inbox submissions keep
their no-retry policy.

The execution service already drains raw prompt/steer work before propagating a
prompt rejection. Between prompts it now uses
`retireSessionForReconfiguration(activeSession)`: verify the exact instance,
detach its lifecycle events, and await real termination before restoration. The
runtime stays bound to the old Session until success. Its existing disconnected
release flag also covers missing-session retirement, so failure and Stop cannot
discard that cleanup owner. Success clears that flag before binding a healthy
replacement and drops the old prompt's completed cancellation-drain receipt, so
Stop drains the replacement's raw prompt. Persistent cleanup failure retains the
existing runtime/release failure; it does not authorize another producer on unresolved resources.

The current [native presence lease](../architecture/2026-10-13-effect-session-presence-leases.md)
already survives incidental lifecycle clears. Adding heartbeat repair would leave
history/output corruption intact. Reopening the turn after termination would race
the asynchronous old finalizer. Removing automatic retry would regress the
existing user-turn policy. Reusing retirement needs no new registry or abstraction.

Effect skill mode: feature/fix. The changed workflow already composes native
Effects; Session/process acquisition and MessageHandler remain unfinished upstream
orchestration. Expanding their migration would not help this event-source fix;
no migration boundary or ledger claim changes.

## Verification and limits

The owning ACP batching suite connects real Session termination, SessionManager
forwarding, MessageHandler, transient state, offline SessionDocument, native
presence and the renderer conversation-index rule. Explicit gates exercise
resume/no-resume and both lifecycle-finalization orderings, cleanup rejection for
connection-closed and missing-session errors, Stop during retirement and during
the replacement prompt, and the no-output/one-retry submission restrictions.
The four owning suites pass 369 tests, and CLI typechecking passes. Temporary
ablations restore ordinary termination, omit failed-retirement ownership, or
retain the old drain receipt; each fails its corresponding behavioral regression.

The provider and Git observation are synthetic. This does not establish live
provider or packaged desktop behavior. Detaching listeners does not revoke a
consumer that entered earlier: independent resource-limit/error finalizers and
arbitrary callbacks already queued by a provider are outside this regression's
claim. Ordinary ACP exit does not itself publish a Session exit event.
