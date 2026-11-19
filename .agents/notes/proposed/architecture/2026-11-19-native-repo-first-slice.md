# Native Repo first slice

Status: proposed
Translation: current

[中文](2026-11-19-native-repo-first-slice.zh.md)

## Abstract

The closed #2892 prototype proved SDK feasibility but duplicated domain lifecycles
and migration owners. This rewrite starts with one opt-in local Preview comments
dataset, one SDK host and one shared observation lifecycle. It keeps existing
rooms untouched and uses precise Flock reads and conditional writes. The cost is
an intentionally separate experimental dataset until a generic migration executor
can preserve original causal/container and tombstone/clock evidence.

## Decision and alternatives

Preview comments have a finite command surface; Schedule definitions also bind
registry publication and execution. Starting with Schedule would therefore widen
the first ownership change. Reusing the SDK's daemon-owned `ensureEngineHost` and
main's `connectEngine` avoids another host supervisor. A window releases only its
own client/observations; daemon exit invalidates the experiment's views. A new
process can reopen the persisted host, and the SDK reconnect supplies a snapshot.

The [earlier rollback](../../implemented/simplification/2026-10-19-repo-upgrade-without-consumer-migration.md)
continues to govern existing consumers. The broader
[workspace-data proposal](2026-10-14-workspace-data-services.md) remains a proposal.
Neither is superseded by this separate dataset. Per-domain migration and a
second renderer writer are rejected here; the next slice supplies one executor.

## Lifecycle and failure containment

An observation begins on acquisition; its handle exists before readiness.
`observeRoom` mutes callbacks synchronously on release and accepts patches only
for the current snapshot generation. It delegates reconnect and release receipts
to the SDK/IPC transport. This small callback fence is shared by both transports;
Effect fibers would not replace the foreign notification handle's identity.

Online release failure is retained by the main window registry (maximum 128
observations per window) and remains retryable by id. Window destruction or
main-frame navigation closes each observation's client even if its release failed;
a disconnected SDK generation is a terminal receipt, not a successful online ACK.
Failures do not stop another window, room or the default legacy path. A slow
native operation is not cancelled by abandoning its JS waiter. No replacement
writer is started to work around an unconfirmed close.

The daemon's native SDK acquisition/release is one Effect Scope resource unit.
It adapts genuine SDK I/O, not the existing Promise Repo workflow. Broader Repo,
cache and application owners retain their current boundaries. SDK synchronous
native stop and packaged shutdown latency still need platform acceptance; a JS
timeout would not prove native thread termination.

Writes do not automatically retry after disconnect or conflict. Their stable
comment ids allow exact-key reconciliation; a missing ACK cannot prove absence.
Commit/visibility is local only. An invalidated view preserves the last projection
but rejects mutations until a fresh snapshot; a terminal gap requires reopening.

## Evidence and limits

The [design](../../../docs/native-repo-first-slice.md) records slicing and budgets.
Shared tests use a real addon, disk, another OS process, disconnect/restart and
conditional conflicts. The Electron IPC suite uses real decorators, trusted-window
admission and engine connections with synthetic identities. Packaging probes load
the staged current-platform addon. These do not establish a signed installer,
real-window UI, all-platform packaging, cloud replication or migration acceptance.
