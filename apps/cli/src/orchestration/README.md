# Reconciliation feedback

Binding constraints live in [AGENTS.md](AGENTS.md). This page explains why
connection lifetime and change notifications matter to the coordinator.

`operation-store.ts` uses SQLite WAL. Closing the last connection checkpoints
and removes WAL/SHM sidecars. Opening and closing for each reconciliation makes
`operation-coordinator.ts` observe its own filesystem churn. Multiple workspace
coordinators share the machine store and can amplify those notifications.
Per-call MCP opens can also perform maintenance writes and trigger lock contention;
the coordinator owns maintenance, while MCP keeps a read-only schema probe before
any required migration.

`operation-progress-history.ts` projects target execution into a requester card.
With nested A -> B -> C sessions, A observes B, while B contains a card for C.
Mirror notifies subscribers even when a state updater returns unchanged history.
Writing the same card can therefore schedule another reconciliation indefinitely.
The preflight comparison avoids entering Mirror; real writes recompute against
current history so a preflight snapshot cannot overwrite an intervening update.

The real-Mirror regression is in
[operation-progress-feedback.test.ts](../../tests/operation-progress-feedback.test.ts).
