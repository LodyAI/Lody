# @lody/e2ee-lab

Content uses compact v2 (141B inner overhead). Sessions and hosts supply trusted Org/document/purpose; packet signing keys are candidates resolved through the verified ledger. SDK AAD is external to ciphertext and covered by AEAD/signature; provider headers 3/4 reject old 1/2. Old v1 or pre-optimization v2 content/repro directories require their pinned old reader; use a new directory for this revision. See the [content spec](../../specs/e2ee-content.md).

The E2EE catalog pins Effect **4.0.2**. `LabRun` builds services once per owner,
keeps a persistent Scope, and interrupts active fibers before awaiting finalizers.
Host startup acquires SQLite/Riverrun/HTTP resources in that scope, including cleanup
when startup fails; Promise `host.close()` and `session.close()` must be awaited.
Session ledger intents use declared `SessionLedger` workflows. HTTP request handlers
and streams-crdt callbacks remain explicit native Promise bridges.

Scheduler state lives in a per-runtime Ref. Deferred gates require explicit permits;
request/completion notifications wake a scoped queue consumer instead of interval
polling. The Effect Clock watchdog is separate from logical scheduling. Native SDK
callbacks still use an explicit AsyncLocalStorage bridge for nested event parents.
`runtime.close()` rejects pending gates; await `runtime.dispose()` for fiber cleanup.

[中文](README.zh.md)

Local deterministic E2EE collaboration lab. Not product E2EE and not Lody
integration. Honest clients are programs; only an attacker Agent (P4) explores
malicious-server mutations at recorded event boundaries.

Rotation recovery uses core's exact-record candidate classification. A corrupt
pending journal is not treated as empty; a confirmed candidate is persisted to the
key file before becoming available in memory. Failed key persistence retains the
candidate for retry. Key commitments and envelopes use the Org hash, not the full
genesis record. Old captures with the incorrect record context are not silently
migrated; record new evidence against the corrected tree.

## Commands

```sh
pnpm --filter @lody/e2ee-lab check
pnpm --filter @lody/e2ee-lab run scenario:collab
pnpm --filter @lody/e2ee-lab run attack:model   # needs a model key (OPENROUTER_KEY etc.)
pnpm --filter @lody/e2ee-lab run replay
pnpm --filter @lody/e2ee-lab exec tsx src/repro-cli.ts replay /path/to/pack
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data --test
```

`check` is typecheck plus tests. Root commands do not build the old demo UI.
`scenario:collab` runs the ongoing multi-member script (Alice/Bob/Carol/Dave/Eve —
offline reconnect, revocation and epoch rotation, snapshot bootstrap, removal of
Eve with the removal-to-rotation window, an offline edit queued before the
removal and uploaded after it, guest demotion, crash recovery): a no-attack
control first, then fixed attacks at chosen event boundaries, including a
per-client split view that hides Eve's removal from Bob. From Eve's removal on,
the attacker holds her retained keys (`insiderRead`); the judge checks that
nothing sealed afterwards opens with them. Reports list one verdict per property
(`report.properties`). `attack:model` runs a budgeted multi-round model agent:
it may wait for a named step, act, read its errors and insider results, and act
again. Configure it with `E2EE_AGENT_GOAL` (`insider-read`, `forge-content`,
`ledger-fork`, `any`), `E2EE_AGENT_MODEL`, `E2EE_AGENT_TEMPERATURE` (default
0.7), `E2EE_AGENT_SEED`, `E2EE_AGENT_MAX_DECISIONS`, or a custom
`E2EE_AGENT_URL`/`E2EE_AGENT_KEY`. `replay` re-runs CAS, lost-ACK,
ciphertext-mutation and the same recorded attack in three fresh directories
each, model-free, and fails at the first diverging event, entropy request,
protocol frame or client state. Private device material stays in the test
process; it is not written to the public trace. Independent packs
(`e2ee-lab-repro/v1`) bind HEAD **and** the dirty-tree hash; `repro-cli.ts replay`
runs in a new process and prints only the failure fingerprint. Private material
is mode 0700 and is not written to stdout.

## Backend

The host is a thin gateway in `src/platform/host.ts` in front of official sqlite
Riverrun `0.3.0`. Riverrun stores ciphertext and CAS; Org membership and write
rights are decided from the verified ledger, not from Riverrun tables. Malicious
tests still call `riverrunUrl` directly. There is no browser UI. The vendored
continuationOffset streams-crdt tarball is required.

## Status

P2 replay is in `test/replay-bytes.test.ts`. P3 fixed-attack matrix is in
`test/matrix.test.ts`. P4 AttackLab isolation and LLM-free action replay are in
`test/attack-lab.test.ts`. Ongoing multi-member collaboration, boundary attacks
and three-directory model-free replay are in `test/collab-scenario.test.ts`;
real-model intervention is in `test/restricted-agent.test.ts`. AttackLab
clock/fs/HTTP go through Effect `LabClock` / `LabFs` / `LabHttp`
(`src/services/`); Promise methods provide `LiveLabLayer`. Isolation is the
capability handle only: not an OS container, and Effect is not a sandbox.

Epoch rotation now delegates to the core Effect workflow, rather than a second Lab
implementation of candidate signing/retry/installation. Normal file writes use the
native atomic/fsynced adapter; injected `LabFs` remains available for deterministic
fault tests. JSON key/candidate formats are unchanged; `.lock.sqlite` files contain
only operational locking metadata. Different pending operations produce the typed
`PendingOperationExists` failure, and storage faults produce `StorageError` rather
than a generic unknown result. Listed Promise SDK boundaries that remain: host
HTTP callbacks and response-body reads, `createStreamsContentProvider` for
streams-crdt, `createContentSnapshotPublication`, and demo `backup.ts` file wrap.
Those unwrap core workflows; they are not a second content or admission algorithm.
Reproduction packs, fingerprints, and minimizer coverage live in
`test/repro-pack.test.ts`. Nested streams-crdt import/read request order is not
a controlled microtask boundary; collab replay uses the oldest-runnable FIFO
rule. SIGKILL crash recovery is tested; power-loss of unflushed SQLite pages is
not. See the
[implementation note](../../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.md).

## Central key mailbox

`DemoSession.centralKeyRound(limit)` is an opt-in, finite application event hook.
It coordinates current-key delivery, durable receive checkpoints, device-signed
reports and repair/result recovery over `/v1/spaces/{genesis}/key-mailbox`. The host
requires an Org-bound credential and independently refreshed verified ledger;
SQLite mailbox/index writes are atomic within that store, not with Riverrun control.
`key-distribution.sqlite` keeps client tasks and unconsumed results across restart.
The old scripted `keys` stream remains available. Core's separate coordinator API
provides explicit repair and result acknowledgement. This is a reference HTTP host,
not a Convex deployment or enabled product E2EE. See the
[delivery draft](../../specs/e2ee-central-key-delivery.md) and
[acceptance tests](test/central-key-delivery.test.ts).
