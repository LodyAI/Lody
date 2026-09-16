# Codex usage: native snapshots attributed per turn

Status: proposed
Translation: current

[中文](2026-09-15-codex-per-model-attribution.zh.md)

## Abstract

Codex usage now comes from native cumulative snapshots, with each turn's new
tokens attributed to the model submitted for that turn. This replaces both the
initial raw-response/sidecar ledger proposal and the intermediate unattributed
snapshot design. The adapter keeps only an in-memory previous snapshot and active
turn counters; the CLI preserves turn-scoped accounting identities using the
existing hosted API. Exact crash, fork, reset and reroute accounting is not promised.

## Decision and responsibilities

The initial proposal preserved historical model totals across restarts through
raw completions and a local sidecar. The subsequent native-snapshot simplification
removed that ledger but emitted unattributed totals. The clarified requirement
is to attribute **new usage in the current turn**, not to relabel historical totals
with the current UI model.

```text
native root cumulative snapshot
  -> adapter snapshot difference + submitted turn model
  -> turn-cumulative update + notification-local usageTurnId
  -> CLI stable nativeSessionId:turn:encodedTurnId accounting key
  -> existing hosted per-key/model/field maximum
```

The adapter freezes the submitted model before asynchronous prompt dispatch, so
a later UI model switch does not relabel the active turn. Native Goal continuation
turns retain that submitted model. Duplicate snapshots produce no new tokens.
A resumed native snapshot anchors the comparison without billing its history;
when unavailable, the first snapshot only anchors and may omit a new response.

The CLI recognizes the marker only for Codex. Its accounting identity is separate
from the real ACP session ID and never changes session routing or metadata.
Separate turn keys allow A=10000 followed by B=2000 to total 12000 instead of
taking a session-wide maximum. Unmarked adapters retain their existing scope.
No private backend, Core schema, session metadata baseline, disk sidecar,
raw-response ledger or historical model map is added.

## Tradeoffs and rollout

- Ship the adapter with its matching CLI: an older CLI cannot interpret the new
  turn-local cumulative scope correctly.
- Native child-thread usage is not added to the root. Reroute, compaction/reset,
  fork and crash recovery remain best effort; there is no durable replay ledger.
- Existing experimental usage rows are not migrated or reconciled. Old sidecar
  files are ignored, not deleted. Runtime artifacts still need rebuild/release.
- Both intentional gitlink changes remain uncommitted.

## Evidence and limits

Behavioral tests cover model switches, submitted-model freezing, Goal continuation,
duplicate snapshots, resumed history, missing resume snapshots and counter resets.
The parser-to-usage-service test covers turn A=10000, turn B=2000 and a restarted
service's turn C=500, with simulated hosted maximum persistence totaling 12500.
The final validation results are reported with the commits; earlier snapshot-only
validation is not evidence for this revision. No paid model completion, deployed
cloud reconciliation or real crash test has run.

- [Adapter PR #45](https://github.com/LodyAI/acp-extension-codex/pull/45)
- [Lody PR #736](https://github.com/LodyAI/Lody/pull/736)
- [Usage delivery Spec](../../../../specs/usage-delivery.md)
