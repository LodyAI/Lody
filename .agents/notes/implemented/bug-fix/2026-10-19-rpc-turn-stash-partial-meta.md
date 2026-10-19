# Keep a stashed RPC turn until session ownership is known

Status: implemented
Translation: current

[中文](2026-10-19-rpc-turn-stash-partial-meta.zh.md)

## Abstract

The first message of a newly created Session could stall for minutes and then
fail as undelivered, while later messages in the same Session started at once.
The daemon accepts that turn over Machine RPC before the Session's metadata has
reached it and keeps the payload in a short-lived stash; a metadata reconcile
dropped the stash whenever a metadata record existed without naming this
machine, including a record whose `machineId` had not synced yet. The stash is
now dropped only on a definitive verdict: deleted doc, archived Session, or a
`machineId` naming another machine. A turn whose ownership never arrives is
held until the existing stash TTL rather than discarded at the first partial
read.

## Evidence

- Symptom (lody 0.106.0): the first message of several new Sessions waited six
  to nine minutes or never ran; the second message dispatched immediately,
  because its offer arrived after the record carried `machineId`.
- loro-repo 0.23.2 stores a document's existence key (`["e", id]`) and each
  metadata field (`["m", id, field]`) as separate rows. Its `getDocMeta`
  snapshot returns `{ deleted: false, meta: {} }` once the existence key is
  present, before any field row has synced.
- `reconcileSessionWatch` treated every non-owned result with `meta` set as
  foreign and deleted the stash, although its own comment and the Session
  dispatch rule call absent metadata "unknown". `offerRpcTurn` already refused
  only a mismatching `machineId` or an archived Session.
- Without the stash, the turn's payload exists only in the history CRDT. If
  that entry does not arrive within the five-minute history wait, the turn is
  marked missing-history and does not run.

## Decision

The reconcile keeps the stash unless the record is deleted, archived, or names
another machine; the same truthiness rule as `offerRpcTurn` applies to
`machineId`. A record without `machineId` still stops the watch for now, as
before, and the next metadata event re-runs the reconcile once ownership
lands. The change removes a drop; it adds no wait, fence or retry. Retention
stays bounded by the stash TTL and the sweep on each accepted offer.

## Verification

`apps/cli/tests/session-dispatch-watcher.test.ts` stages the metadata: offer
accepted with no record, then `{}` or `{ id }`, then the owned record with
`latestUserMsgId` set and no history entry. On the previous code the stash was
gone after the partial record and the Session never started; now it starts
from the stash with `dispatchSource: 'rpc'`. Guard cases (another machine,
archived, deleted doc) still drop the stash, and each fails when its clause is
removed from the condition. Not reproduced against a live sync between two
machines.
