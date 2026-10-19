# Native local presence and the process-wide connection writer

Status: implemented
Translation: current
PR: [#1519](https://github.com/LodyAI/Lody/pull/1519)

[中文](2026-10-12-effect-local-presence-writer.zh.md)

## Abstract

The local data plane's Promise pump could stop its queue without joining a running
Flock export, and separate workspace writers did not share physical socket backpressure.
A native Effect 4.0.2 service now owns the process pacer, ordered workspace lanes and one
write/drain owner per connection. Actual doc/socket consumers use this kernel through one
explicitly deprecated Legacy executor; presence snapshots materialize at writer execution,
including the final deletion. This completes the lower writer responsibility, while room,
LoroRepo and full application lifecycle integration remain Legacy. Remote workspace
presence now has its separate P5 owner.

## Responsibility and dependencies

```text
application / one local-loro-writer Legacy executor
  LocalLoroWriterLive (native FIFO task/frame and release ownership)
    LocalLoroWriterTurn -> Node host-turn adapter
    connection.send/onDrain -> single Node socket adapter
    task.build -> ordinary CRDT/frontier/framing + native Effect composition
      LocalLoroPresenceSource -> synchronous local-origin encode/subscribe
      machine-monitor -> synchronous encode/apply/subscribe
      exportLocalFlock -> actual third-party Flock SDK exportJson boundary
  LocalLoroDataPlaneServerLegacy (upstream temporary assembly)
    resolveDoc / resolveFlockDoc / resolveMetaFlock -> Promise LoroRepo owners
    join/leave/import and room notifications -> existing Legacy room lifecycle
```

The SDK's plain version-vector export is synchronous; its options/hooks path can return
an actual Promise. The sole SDK adapter keeps that Promise uninterruptible until actual
settlement because the SDK exposes no cooperative abort contract. Pure Loro export,
version capture, chunking and per-peer frontier calculations remain ordinary computation.
The old `pumpWriter`/scheduler Promise workflow is deleted, not adapted through `tryPromise`.
Room resolve/join/leave/import is not fed through such an adapter either. The terminal
oversized-Flock-entry branch still delegates room release/notification to the Legacy
room owner; this is a registered upstream lifecycle boundary, not a native room claim.

The inspected main lacks the earlier `specs/local-first-two-plane.md` path. Its required
local-origin, dual-author and unload-before-invalidate constraints were checked against
scoped instructions, existing implementation/behavior suites and the owning presence
Spec; no replacement Spec was created. The root roadmap ledger records this lower native boundary and its pending upper owners.

## Contract and API

- **Trigger:** CRDT/source changes admit names/Effects, never inline export. One task or
  remaining chunk crosses the host turn. All kinds share each workspace's ordered lane;
  lanes rotate across connections and workspaces, including one multiplexed socket.
- **Owner:** one application provides `LocalLoroWriterLive` and one `LocalLoroWriterTurn`.
  `offer`, `dropRoom` and `revoke` are synchronous admission/fencing operations;
  `closeOwner`, `disconnect` and `close` are native Effects. The connection owns one drain
  subscription and backpressure latch across all workspace lanes.
- **Cancellation:** disconnect/dispose revokes queued work immediately. A running SDK
  export remains owned until its actual settlement; signals/timeouts do not establish
  release. Generation/subscriber/requestId fences prevent late writes or frontier advance.
- **Handoff:** `send(false)` accepts the frame but pauses subsequent export/send. Drain
  resumes parked lanes in their prior order. Presence dedup retains one running plus one
  queued task, snapshots at execution and keeps the final clear/delete. Per-peer frontier,
  chunk ordering and machine-monitor observer behavior are preserved.
- **Failure/recovery:** concurrent close shares a Deferred receipt. Each raw-work observer
  wait has a five-second Clock bound, including inside Scope finalizers. Failed unsubscribe
  or unresolved settlement retains the connection and complete Cause in
  `LocalLoroWriterReleaseFailed.retry`; replacement remains blocked. Root close can observe
  the one raw producer twice, for at most ten seconds of observer waiting. Retry uses the
  retained owner, not a second `Scope.close`. Legacy projection retains the complete Cause.

`makeLocalLoroWriterLegacy` is the sole writer runtime executor. CLI doc construction
uses its process singleton with `LocalLoroWriterNodeTurn`; Node socket close/stop and
manager cleanup await release receipts. Remove the executor after those application
owners provide the native service. Engine assembly/room hooks and Fleet's wider Promise
cleanup (including its existing failure logging) remain outside this migration. The
socket/application writer registry retains failed lower owners despite that wider Legacy
policy. This does not complete full P7, Session/Turn or the complete Loro stack.

## Source evidence and alternatives

Pinned Effect 4.0.2 `internal/effect.ts` implements `sleep(0)` as `yieldNow`; its mixed
scheduler starts with microtasks. An exact-version experiment queued 40 frames before an
already registered host turn: `yieldNow` and `sleep(0)` sent all 40 first; the Node adapter
sent zero first. The platform `setImmediate` callback is therefore necessary here.
Semaphore serialization alone supplies neither this host quantum nor shared socket
backpressure/parked ordering. Separate workspace runtimes would create competing writers.

Automatic scoped joining of a non-cooperative SDK producer would defeat an observer
bound. The explicitly owned worker remains available after bounded finalizer failure.
Cause handling uses complete Exits; finalizer Fail-to-Die conversion preserves every
reason and annotation, instead of v4's failure-selecting `mapError`/`orDie` projection.
No payload/error stringification was added to logging or new diagnostic fields introduced.

## Verification

Base: `3ac76bad10f46720517a2ca6929f03de4ef5bb9b`, verified against remote main. Shared baseline:
112 files / 1427 tests passed. CLI baseline: 5 failing files, 15 failing tests, 4 unhandled
errors; focused socket/doc/relay baseline: 30 passed. Child test processes only isolated
Git-config contamination; global Git config and the parent checkout were untouched.

The existing shared server/framing/transport suites use fake clocks, explicit host-turn,
export, drain and completion gates plus TestClock. New cases cover cross-workspace
backpressure, snapshot-at-write/final clear, actual SDK settlement, concurrent close,
retained release failure/recovery, finalizer bounds and mixed Fail/Die/Interrupt.
The CLI suite uses an actual Node Writable high-water/drain boundary and retains the
real Unix socket overflow regression with message/close signals. Dual-author coverage
uses the actual Flock/Loro adapters. Mock-call-only assertions were replaced with state;
the shallow unload source-text test was removed in favor of existing real unload coverage
and the AST boundary guard.

Five sequential temporary ablations each fail their owning behavior test: host quantum,
backpressure, eager presence snapshot, omitted settlement join and superseded-join fences.
The initial fairness test survived removal of the turn; explicit admission-versus-early-write
signals corrected that test gap before the successful ablation. Scripts stay outside product
code. Integration review is based on `dd674eae` and reuses merged P5. A frozen install in an
independent clone keeps locked versions. Full shared validation passes 112 files / 1458
tests; actual CLI socket, unload, dual-author and zero-cloud integration passes five files /
37 tests. Root typechecking, lint, format, document and public/native boundary checks
pass. The renderer reconnect harness injects the native writer, drives the actual
room adapter/health predicate with fake clocks, and awaits engine/writer release.
The full third components shard passes 186 files / 1799 tests.
The complete local CLI phase passes 4052 tests with the same five baseline suites
(15 failures / four unhandled errors) in Git/process fixtures; remote CI must validate the submitted revision in a clean environment.

Validation is local Linux/Node source-level evidence. It does not establish Windows/macOS,
packaged desktop/CLI installation, production load or native ownership of the upper stack.
