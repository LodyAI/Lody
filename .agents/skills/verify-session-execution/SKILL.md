---
name: verify-session-execution
description: Model-check Session Inbox multi-client delivery, Stop, submission, retained retries, output waiting and cross-session progress; replay findings against production dispatch, gate, Effect and SQLite boundaries.
---

# Verify Session Inbox availability and execution

Use for the covered delivery, dispatch recovery, Inbox service, SQLite, execution owner and reply-ordering gate. This is one subsystem with scheduling, delivery, output and shared-writer retry slices, not a proof of their entire composition. Follow [coverage.json](coverage.json), [expanded-coverage.json](expanded-coverage.json) and [requirements.md](requirements.md). Source mapping pins the verified product commit and exact source hashes. The separate verification commit follows that product commit.

## Run

From the repository root:

```sh
python3 .agents/verification/state-machines/check.py
```

On a new machine add `--prepare-tools` once. It installs the portable locked dependencies in an external temporary directory, never in the app. The lockfile pins transitive packages and integrity checks for `npm ci`; keep it for reproducible native-SQLite replays. `--tools` selects an existing exact-version tool tree; `--out` must be fresh and outside the repo. Use the supported Node runtime, Python 3 and Java 11+. TLC is pinned and checksum-verified. BFS temporal checking needs local RMI socket access; unavailable execution is not PASS.

Exit 0 means all requested current-source properties passed. Exit 1 is a property failure. Exit 2 means the check could not complete. Failed old-code variants are deliberate mutations and must be caught; a failing current baseline must never be relabeled as an expected PASS. `summary.json` keeps raw evidence paths separate from property results.

The current corrected baseline checks:

- Shared SQLite BUSY: one native blocking attempt per scan, retained work, scoped retry cancellation and recovery after unlock. `BusyScan.tla` abstracts the delay; native SQLite plus TestClock checks the real implementation. The original driver's single-call five-second wait remains.

- Scheduling safety, Stop/final start, fixed membership, unknown non-replay, retained receipts and independent-session progress under a persistent local fault.
- Two-client history/RPC/receipt/activation delivery, permanent first-input partition, per-ID negative acknowledgements, and eventual explicit outcome under the declared fairness assumptions.
- Output waiting with a hung pre-open callback: the original deadline or disposal releases waiters, and cooperative late callbacks do not issue stale writes. Progress does not assume the user eventually presses Stop.
- Real Effect/SQLite source traces, two batch-local SQL faults (trigger and native capacity limit), independent retry categories, prepare/report/launch failures, 336 Stop/new-input/epoch timelines, 24 cancel snapshots and 30 arrival-order snapshots.
- Broken model/source variants that restore scan blocking, drop receipts, bypass start/owner fences, forget negative acknowledgements or strand output waiters.

`expanded.py --source-only` runs the additional source witnesses. `--safety-only` uses exhaustive DFID safety checks and explicitly omits temporal properties. It requires TLC's completion message, not merely reaching its depth budget. Neither option is a replacement for the default full check.

## Preserve the boundary

A local failure affects its dependent action. Retry every independent receipt, retain failed entries and return the full combined Cause to an explicit recovery caller. Background scanning reports that failure and continues. Prepare each candidate independently. A shared `OrchestrationStorageFailure.kind=busy` stops that connection's current pass and arms one scope-owned retry (250 ms doubling to 2 s); coalesce scan wakes until it fires. Publishing its flag and fiber is uninterruptible, but its delay is interruptible. Explicit admission remains available, and scope closure cancels the retry. Do not treat row-local errors or `SQLITE_FULL` as a shared lock. Diagnostics and synchronous adapter exceptions cannot kill the scanner or strand `running`. Stop vetoes the affected old input; it is not a workspace readiness gate. A completely unwritable database cannot authorize unrecorded input, and an unknown submitted request must never replay.

`missingHistoryUserMsgIds` is host-owned, append-only identity evidence, with legacy scalar compatibility. Only the serialized host watcher appends it. Producers never clear acknowledgements to publish a new activation. Old timeouts cannot accuse newer activation. Every input eligibility path and the renderer use the shared predicate. Test fresh-ID progress as well as old-ID exclusion.

The reply gate has waiting/opening/open phases. Keep its original deadline while the pre-open callback runs. Deadline releases waiters while the live callback continues adding author/model metadata. Only disposal (including after timeout already opened the gate) aborts later callback steps; abort does not undo an already-issued write. The MessageHandler checks that signal before issuing its assistant-entry write. Finalization disposes its captured gate before persisting `finish-assistant`; do not wait until turn-state cleanup. An old callback or finalization cannot cancel a successor gate.

SQL commits are synchronous transactions. Do not combine across real awaits or introduce a global Wait to conceal a deadlock. Keep the worker latch, durable slot, provider work and retained write receipts distinct. The native service is already Effect v4; this repair adds no runtime owner or migration chain.

## Model upkeep and statecharts

Read owning AGENTS.md, the Session orchestration Spec, the failure-containment guide, Effect reference and [the storage decision](../../notes/implemented/bug-fix/2026-11-10-missing-history-acknowledgements.md) before editing a mapped boundary. Review source changes before refreshing hashes. Replay every new counterexample against real code; a source-selection witness is not evidence of actual Agent execution.

Read every TLA+ result using pstack `/statechart` at commit `6b0300214a09fd6029cfb7077043125758cd1fd2`. Run `<pstack>/skills/statechart/scripts/statechart <external-output>/expanded/gate-completing/Model.tla --config <external-output>/expanded/gate-completing/Model.cfg --view .agents/skills/verify-session-execution/gate-view.mjs --out /tmp/lody-gate-chart-new`; use a fresh external output folder. Reports and TLC output stay there; copy only the necessary Mermaid source into this skill. Use `view.mjs` for the restricted scheduler chart, `gate-view.mjs` for the current reply flow, and the diagnostic views for complete loop/mutation reports. The main source checker writes each checked model/config to its external result folder for this purpose. Charts over 500 states may be omitted; the report still records the checks. Presentation scenarios and merged labels are not the proof bounds.

[The explanation](../../docs/app-state-machines.md), current charts and coverage maps describe the scope. Raw reports and result snapshots are generated only in the external output folder. This is finite model checking and production-boundary replay, not unbounded full-app refinement, real replication/E2EE/host-lease proof, provider execution, mobile/native acceptance or proof that failed storage is available. Use pstack `/maintain-formal-verification-skill` after covered changes that bypassed this workflow.
