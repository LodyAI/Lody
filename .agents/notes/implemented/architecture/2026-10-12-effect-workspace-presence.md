# Native workspace presence ownership

Status: implemented
Translation: current

[中文](2026-10-12-effect-workspace-presence.zh.md)

## Abstract

The old workspace coordinator could discard remote handles before their I/O ended
and kept bootstrap readers beyond their deadlines. Workspace presence now owns
heartbeat and remote generations in native child Scopes, retaining failed releases
and their full Causes until actual cleanup. Product doc/bridge consumers acquire
workspace owners from the CLI application registry and borrow one native token
provider for durable and ephemeral requests. The published SDK supplies transport
ownership; session-active leases and local relay pacing remain separate P6/P7 work.

## Behavior contract and composition

Authorized attach starts a remote generation. Local origin-partitioned stores and
30-second machine heartbeats exist independently of cloud authorization. The CLI
root supplies one application runtime for shell cache and workspace registry;
`presence-legacy.ts` is the only presence execution door for current doc/bridge,
Session and reader consumers. Delete it when those consumers compose the service.
CRDT encoding, parsing, set/delete and snapshots remain synchronous in
`PresenceReplica`; relay payloads contain only locally authored state.

Each workspace creates its token provider in its child Scope. Durable Streams and
machine monitor borrow `createLoroStreamsTokenProviderLegacy({provider, executor})`
with that same provider and application executor; presence uses its native callback.
The borrowed mode creates no runtime or second cache and never disposes its executor.
Native acquisition is lazy; local-only startup reads no credentials and opens no
cloud request. Revocation retires both remote sinks, removes durable transport and
closes the provider while keeping local publication alive. Reattachment creates a
fresh provider only after the previous provider's cleanup succeeds.

Remote detach fences admission, interrupts owned tasks, starts SDK shutdown,
awaits actual exits with a bounded observer, then closes the generation Scope.
A deadline retains the original release Fiber, owner and complete Cause; replacement
stays forbidden. Concurrent stop/detach shares a Deferred receipt. Explicit recovery
joins original work and invokes SDK retry only after failed release settles.
Workspace stop closes remote I/O before its token Scope and store destruction.
Token Scope failures are recoverable only for recognized providers owned by that
workspace; successful native retry proves actual cleanup before the historical Scope
failure can be treated as recovered. Foreign failures remain observable.

Reader cancellation ends only its bootstrap/barrier/token waiter, never another
lease's producer. Application disposal transfers retained workspace/shell owners
into its full Cause; the combined recovery dispatcher preserves unknown failures.
Doc initialization, attach rollback, detach and final cleanup preserve release
errors rather than logging or dropping them. Remaining Promise doc orchestration
is outside this native unit and is not claimed migrated.

Scope.close does not join a previous close, and an uninterruptible finalizer cannot
be bounded by interrupting it. Explicit receipts and retained release Fibers are
therefore necessary over pinned Effect 4.0.2 primitives. This replaces the lifecycle
mechanism in the [presence budget decision](2026-09-20-ephemeral-presence-channel-budget.md),
while preserving rate/size obligations, three-state readers and sole session writer.

## Published dependencies and evidence boundaries

The platform adapter consumes official `streams-crdt@0.17.0/effect`, with
`streams-client@0.10.0`; no source bundle, local tarball, dependency override or
second POST/SSE queue enters product code. Exact reviewed versions are allowed by
minimumReleaseAge; unrelated lockfile resolutions remain unchanged. loro-repo 0.22.0
still advertises an older CRDT peer range; real durable checkpoint and product
boundary suites validate this selected combination, rather than treating that
warning as compatibility evidence.

During review, upstream normal stop after clearing local presence reproduced a
pending=0 EphemeralReleaseFailure containing EphemeralClosed. The queued send had
not acquired HTTP before retirement. [loro-streams#410](https://github.com/loro-dev/loro-streams/pull/410)
now interrupts that canceled task while preserving genuine foreign/mixed failures;
the single-send-guard ablation reproduces the failure. Its complete upstream check
passed 637 cases with six skips. Official releases followed client then CRDT via
[#412](https://github.com/loro-dev/loro-streams/pull/412) and
[#411](https://github.com/loro-dev/loro-streams/pull/411).
Earlier temporary source snapshots that passed are not evidence for the originally
failing upstream head; the corrected published release is the dependency used here.

Joined bootstrap, captured logical queue barriers, acknowledgements and peer receipt
remain distinct evidence. SDK stage diagnostics use only safe enums/counts; successful
individual operations and heartbeat use trace, failures debug, bounded retry/stall warn.
A stalled upload never triggers a reconnect automatically. `idle` is an empty local
queue, not proof of peer observation. No telemetry sink is added.

## Verification and remaining work

[Product PR #1510](https://github.com/LodyAI/Lody/pull/1510) replaces the old Promise
coordinator. Owning native cases cover origin partition, heartbeat/revoke, bootstrap
and barrier cancellation, retry fairness, concurrent close, typed/defect cleanup
failures, zero-pending release failures and failed token Scope recovery. Real SDK
Fetch/SSE cases cover an abort-ignoring POST retaining replacement fencing until
settlement, shared P4 token demand across room cancellation, reattachment sending
machine state to a real EphemeralStore, and successful normal shutdown.
The borrowed token test also cancels a Legacy waiter without canceling a native
waiter, proves shared caching and leaves the application executor usable after close.
Product manager, local data-plane/zero-cloud and durable checkpoint suites exercise
the registered consumer boundary. Fake timer fixtures leave Effect's scheduler
running and control only their actual timer clocks; native cases use TestClock
and explicit readiness signals. Previous mechanism ablations detect lost typed
Causes, premature generation replacement and nonjoining concurrent close.

P6 session-active ownership and P7 local relay pacing, broader document/Session/Turn
ownership, macOS/Windows packaging and production daemon end-to-end acceptance are
not completed by P5. Final workspace typechecks and type-aware lint pass; focused presence/logger/product
manager/durable checkpoint cases pass 52, token/shell cases pass 72, and real local
zero-cloud/data-plane cases pass six. Renderer presence cases pass 33. Its deadline
fixture now settles auth on AbortSignal and advances the default retry backoff,
matching the actual token facade; an infinite callback ignoring cancellation is
unresolved owned work, not successful deadline cleanup. Fake timers leave the
Effect scheduler unfaked. Format, frozen install, docs check (zero errors),
i18n and all five boundary guards pass. Recursive validation reports CLI 4,052 passed,
15 failed, one skipped and four unhandled errors. The five failing process/Git shim
suites reproduce the same 15 failures/four errors on unchanged P1 source, whose
relevant files match current main; the four-suite retry uses a five-second diagnostic
limit. Other recursive verification did not finish after this failure; Electron was run
separately and passed all 216 cases. No green full check is claimed; focused acceptance does not replace the stated limits.
