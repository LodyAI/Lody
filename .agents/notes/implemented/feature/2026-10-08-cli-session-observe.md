# Expose Session observation through the CLI

Status: implemented
Translation: current

[中文](2026-10-08-cli-session-observe.zh.md)

## Abstract

Independent terminal programs could control Sessions but could not attach to an
existing Session for continuing structured observation. `session observe` now
wraps existing metadata, control and backend-neutral history subscriptions in a
versioned JSONL stream, with outcomes derived from durable turn evidence.
Workspace observation multiplexes a catalog and bounded document opens in one
process, leaving historical idle rooms unopened. Read-only opening and cleanup
are tested against a real persisted document; authenticated provider execution
and external Connector interoperability remain unverified. This increment uses
the Cloud CLI path; local-only attachment needs a separate daemon adapter.

## Decision and evidence

Implement the approved generic CLI increment rather than a new External Control
API, Operation model or dedicated UX. No Connector-specific code is required.
The [draft Spec](../../../../specs/cli-session-observe.md) owns current behavior;
this note does not confer Spec approval. Existing non-waiting create/chat receipts
already identify Session and User Turn IDs. Consumers can dispatch, then observe;
a timeout is not permission to blindly repeat creation.

The existing wait loop proved reusable for terminal classification but not for
its one-turn lifetime and content updates. Extract its pure outcome classifier:
User handled plus linked Assistant finished/endedAt proves completion; User
failed/canceled separately proves those results. Keep wait's update/done wire
format and errors unchanged. Presence loss or metadata idle never proves completion.

The backend's gap-free history directory contains turn identity and scalar
execution state. Observe it and control separately, rather than hydrating full
transcripts on each content change or binding to raw Loro history. Incremental
reads and projected-state comparison emit meaningful transitions without token
traffic. Initial snapshots carry latest outcomes but do not replay old turns.
Sequence orders one process only; consumers own durable observation buffers.

## Ownership and cost

- [session.ts](../../../../apps/cli/src/commands/session.ts) registers flags,
  selection, Cloud setup, metadata watches and process cleanup.
- [session-observe.ts](../../../../apps/cli/src/commands/session-observe.ts)
  owns directory indexes, serialized/revision-fenced projection and a bounded,
  ordered JSONL writer. Diagnostic logger transport is temporarily redirected
  to stderr for structured output.
- [session-observe-runtime.ts](../../../../apps/cli/src/commands/session-observe-runtime.ts)
  owns scoped backend and document acquisition, confirmed catch-up and release.
  The isolated command manager forwards `skipAutoRead` only on new document
  creation; ordinary execution defaults remain unchanged. Cleanup preserves status.
- [session-observe-workspace.ts](../../../../apps/cli/src/commands/session-observe-workspace.ts)
  watches one metadata catalog, reconciles changes during enumeration and opens
  candidates with concurrency four. Retain active rooms through fresh durable
  settlement, then release command-owned scopes. A metadata-only snapshot means
  unknown execution state, not idle; catalog ready does not imply room readiness.

The manager cache has no refcounts. Sharing daemon wrappers and disposing them
would invalidate other subscriptions, so observation uses an isolated manager.
Opening with the ordinary backend would mark pending messages seen and write model
summaries; the explicit read-only option avoids those writes. A real filesystem
fixture checks unchanged operation version, metadata and history before/after
read-only opening and release, with a normal-open positive counterpart.

Watching every historical room would cost one subscription and initial download
per Session. Instead metadata is the activation index; unopened idle body changes
and reopening without metadata activation are outside workspace scope. Four bounds
concurrent acquisition, not total active rooms. Single attachment remains available
when full ongoing observation of one idle Session is required.

## Validation and limits

Deterministic tests cover baseline fast completion, both completion facts, rapid
turns, no-Assistant failure/cancel, reopened Assistant, initial-read races, stale
async reads, loss/catch-up of freshness, content bursts with narrow directory reads,
archive/delete, backpressure, broken pipes and disposal. Adversarial review found
and fixed structural tail deletion, duplicate User identity selection and stale
deletion during catch-up; real history-writer regressions cover all three. Workspace tests cover
1,000 idle rooms, retained execution despite idle metadata, catalog races, bounded
opens and shutdown during acquisition. Existing Session command and wait tests
remain passing. The focused suite has 124 passing tests. Full CLI and workspace checks pass. Cloud bundle and published-import checks pass
with a 4 GB heap; the 2 GB build exhausted memory, so that budget is not verified.
The built CLI help and invalid-flag JSON response were exercised. Synthetic Git
tests need the inherited Agent Git shim/context removed from their test process;
no persistent environment or credential settings were changed.

No real authenticated CLI/provider or external Connector E2E was performed.
Local-only follow requires an adapter to the existing daemon/local transport;
sharing SQLite storage is not a live subscription between replicas. Permission
answering, raw-history export, external request IDs and a persisted event log are
outside this change. Cross-tool memory search was attempted,
but Nowledge Mem was unreachable.
