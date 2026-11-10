# Session Inbox proof obligations

These obligations implement the availability request under the existing [Session orchestration Spec](../../../specs/session-orchestration.md#idempotent-message-consumption). They do not change execution authorization or allow unknown work to replay.

## Boundary and assumptions

Clients publish immutable input identities. History, full-payload RPC, activation metadata and user receipts can reach one execution host in different orders. Inbox SQLite belongs to that host; clients do not each own an executable Inbox replica. Each of two concurrent clients publishes one message; ID 2 is the fixed metadata LWW winner. This abstracts independent document/channel arrivals, not arbitrary reordering within a causal CRDT import. Receipt presence does not prove cryptographic authorization; the existing verified access/signature guards remain required and are outside these models.

The serialized host watcher owns the append-only negative-ack map. A host-lease/process-exit barrier excludes concurrent execution hosts before epoch handoff. SQL fixtures assume that barrier; they do not produce it. An old input may remain unknown or explicitly failed without affecting independent input. A permanent partition cannot guarantee its remote execution. A wholly unwritable store cannot safely authorize unrecorded execution.

## Obligations and current evidence

| ID | Expected result | Evidence |
| --- | --- | --- |
| R01 | Duplicate input, release or Stop cannot restart old work or pause a successor. | Native SQLite in all 336 command timelines, plus submission safety and duplicate-finish source traces. |
| R02 | A usable body and verified execution authority precede actual start. | Delivery model checks body/receipt presence; production start fences remain. Cryptographic authority itself is not proved here. |
| R03 | Stop metadata waits for its matching control request and targets exactly its named input. | 24 real pure-decision snapshots; removing the matching-ID guard is caught. |
| R04 | Stop before final admission prevents start; cancellation after start never proves non-delivery. | Real Effect/SQLite Stop trace, final-fence mutation, native timeline enumeration and unknown-outcome trace. |
| R05 | An old epoch/release cannot start or clear a successor; fresh explicit input and future results remain eligible. | All 336 native SQL timelines include old-owner refusal, delayed duplicate Stop/release and future-input/result checks. |
| R06 | A local receipt failure must not skip independent retries or workspace scanning. Failed records and causes remain. | Current scheduling safety/progress pass; real trigger and native capacity faults allow B to start while A remains failed, and a fresh input in A itself can submit during that failure. A failed pause callback does not skip B release/C settlement. Failed prepare/diagnostics/launch cannot poison later Inbox use. Old blocking scan is caught. |
| R07 | A reported failed identity stays excluded after another timeout or a new producer activation, while a fresh ID remains eligible. | Current delivery safety/progress pass. Actual recovery, history and RPC selection retain both failures; scalar removal does not revive them. An old timeout cannot mark a newer activation. Deleting the map write is caught. Source witness stops at selection, not actual Agent execution. |
| R08 | The original reply-gate deadline or disposal releases existing waiters even if pre-open I/O never returns. Timeout preserves live assistant metadata; disposal cancels late callback steps before finalization marks the entry finished. | Gate safety/temporal profiles pass without disposal fairness. Real gate source checks and owning Vitest cases cover deadline, disposal, late completion, successor isolation and broken diagnostic/cleanup sinks. Old blocking behavior and missing late-write fence are caught. |
| R09 | Under eventual delivery and fair local steps each modeled input completes or has an explicit failure. Permanent loss of input 1 cannot prevent input 2 reaching such an outcome. | Full BFS temporal checks pass. Fairness is per enabled arrival/processing step; output progress does not assume a future Stop. The first permanently lost input may remain deferred; frontend draft visibility is not proved. |
| R10 | Recovery must not poison future Inbox input or silently replay unknown work. | Native fresh-input/result checks, retained settlement repair, scope-local Stop veto and unknown non-replay. Full database outage/draft retention/device reconnect are outside acceptance scope. |

## Slices and interpretation

`Model.tla` keeps the two-session scheduling slice: one submitted A batch, retained failed settlement, B worker/slot/batch, one B Stop, at most two B starts and coalesced wakes. `IsolateRetries=TRUE` now describes production. The legacy progress config is a broken variant, not the current baseline.

`Delivery.tla` adds two inputs and distinct host observations. `DurableFailures=TRUE` now describes the retained per-ID acknowledgement. Arrival set membership abstracts duplicate transport delivery; actual duplicate admission is checked separately. Expire abstracts the deadline for its own activation, and the source replay checks stale-timeout identity.

`OutputGate.tla` separates waiting/opening/open, callback completion, original deadline, disposal, output and cancellation. The release deadline remains live during opening and does not abort metadata creation. Disposal after opening still aborts the pending callback. Late-write safety models the cooperative MessageHandler signal guard, not rollback of an already-issued write. The model has no global Wait.

`replay.mjs` runs actual service, execution owner, repository and native SQLite with injected provider starts and a logger port. It includes trigger rejection and native `max_page_count` capacity rejection of a synthetic approximately 1 MiB A diagnostic while B's small writes fit. This is not real OS disk exhaustion. `sync-replay.mjs` enumerates every order of A accept < begin < submit < settle < release interleaved with B acceptance, Stop and lease-safe epoch change: 336 SQL command timelines, not full watcher schedules. `decision-replay.mjs` compiles complete unchanged declarations and recovery/selection method bodies with synthetic document ports and actual policy helpers.

Default verification checks finite safety and weak-fairness progress. A restricted chart or a source-only/safety-only run is not a complete proof. Current failures remain FAIL, infrastructure failures remain incomplete, and broken variants must fail behaviorally. The map grows with failed identities and follows Session retention; arbitrary eviction would authorize an old failed input again. No payloads are retained in it.

No actual Loro/Roost replication, E2EE/device revocation, host-lease producer, native provider process, full UI/mobile/device acceptance, or unbounded implementation refinement is claimed. Full workspace checks require repository dependencies; a focused external tool tree does not replace those checks.
