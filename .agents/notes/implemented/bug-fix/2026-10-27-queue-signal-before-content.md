# Causal acknowledgement of queue updates

Status: implemented
Translation: current

[中文](2026-10-27-queue-signal-before-content.zh.md)

## Abstract

A queued message could lose its automatic dispatch trigger when metadata arrived
before its control-document row after a turn settled. The daemon acknowledged the
signal against a temporarily empty queue and removed its subscription. Queue writers
now attach the Loro frontier captured after their mutation; acknowledgement requires
that exact signal's frontier to be observed and the queue to be empty. Real-document
regressions pass in both arrival orders. Older writers without receipts retain their
watch conservatively, trading idle subscriptions for avoiding silent loss of dispatch.

## Cause and correction

`createDirectWorkspaceWriter` writes `mq` and then metadata on separate planes;
local write order does not guarantee remote arrival order. Queue-only activation
has no pending user-turn pointer, so the dispatcher's missing-history wait does not
apply. Previously, `markMessageQueueSignalChecked` acknowledged an empty local queue
without evidence that the update it named had arrived. Once other activation reasons
ended, `reconcileSessionWatch` removed the control/history subscriptions. A late row
could then remain until an edit published a fresh watermark.

```text
queue mutation → capture control frontier → publish watermark + frontier
  → daemon observes metadata → keep watch while frontier is missing
  → content arrives → promote/execute queue → acknowledge only after empty
```

The writer captures `messageQueueUpdateVersion` before releasing its store or
allowing another edit to intervene. It contains the existing watermark and the
control-document frontier; it adds no history reads, content copies, network waits,
or root control-schema fields. The daemon checks the applied document version
(`version`, not merely the operation log) against every frontier operation. A
receipt from a different watermark cannot acknowledge a newer signal. Queue rows
blocked by editing, promotion or execution continue using their existing rules.
OSS migration drops the receipt alongside other dispatch metadata.

The [previous queue fix](2026-10-26-dead-turns-and-orphaned-queue.md) protects rows
already present locally. This change additionally protects content not yet observed.
A fixed delay, a pending-upload sync acknowledgement, or a global scan cannot prove
that a particular incoming control mutation has arrived.

## Ownership, compatibility and limits

The existing watcher owns one control/history subscription per activated session.
There is no new timer, Fiber, retry loop, registry, or blocking readiness gate.
Unrelated sessions still progress. A temporarily missing version stays pending until
normal document delivery triggers another check; archive, deletion, reassignment and
watcher stop release their existing subscriptions. Stop and editing semantics are
unchanged. This is a synchronous causal check in existing Promise orchestration;
a native Effect migration would expand into the unfinished Repo/watcher boundary
without helping this fix, so none is included.

For mixed versions, an absent receipt or one left over from an older watermark is
not proof. The daemon retains that activation even after an empty observation; a
later versioned queue mutation can clear it. An old renderer that only deletes its
queue can therefore leave an idle watch until one of the release boundaries above.
This is a deliberate compatibility cost, not a claim of bounded delivery time or
successful synchronization. Already acknowledged orphaned signals from older daemons
still need a fresh activation; this change does not scan all historical sessions.
Older daemons ignore the new receipt and need upgrading to receive the fix.

## Verification

- The existing watcher suite uses real `SessionDocument`, Loro replicas, control
  Mirror and history backend with explicitly ordered metadata and binary-update
  delivery. Both content-first and metadata-first orders run exactly one queued
  turn and empty the queue, with and without versioned receipts. The metadata-first
  case failed before the fix with no dispatch and the row still queued.
- The acknowledgement case covers absent receipts, missing control content, stale
  watermark receipts and an observed remote enqueue/delete that ends empty.
  It replaces the former mock-call-only empty-queue acknowledgement test.
- The writer suite verifies enqueue, edit, reorder and removal receipts: an older
  replica does not contain their frontier; importing the update makes both the
  frontier and resulting queue state agree. These tests use no network or sleeps.
- Full watcher suite: 64 passed. Full workspace-writer suite: 12 passed. Dispatch
  predicates, queue/editing document behavior and OSS migration suites: 49 passed.
  Changed code passes formatting and lint; CLI and components typechecks pass. Agent
  execution and transport are injected boundaries; no packaged desktop, live
  provider, or particular user incident is claimed. No captured user data is used.

Run the reproduction with:

```sh
pnpm --dir apps/cli exec vitest run tests/session-dispatch-watcher.test.ts -t 'automatically dispatches a queued message after turn completion'
```
