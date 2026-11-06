# Queued input evidence in encrypted workspaces

Status: implemented
Translation: current

[中文](2026-11-05-e2ee-queued-input-evidence.zh.md)

## Abstract

A queued input reaches history through a row the machine writes, so that row's signature
names the machine rather than the input's author. Queued input now carries its own evidence.
A human input carries the signed purpose-8 original the client already prepares, and the
start authorizes that original's signer. A machine-authored input carries a local receipt
with a digest of its content. A promoted row with neither does not start. Ordinary workspaces
are unchanged, and no ledger format changes. Runtime originals need clients that include this
change.

## Decision

- **Marker.** In an encrypted workspace, promotion writes `queuedInput: true` into the row.
  The marker only means something on a row this machine signed. The existing signed-row check
  runs first for every queued row, covers the marker, `inputConfig` and `userId`, and supplies
  the content the steps below read. A marked row signed by a client is that client's own input.
- **Human input.** The client stores the frame in `queueDispatchOriginals`, before the queue
  row, in the same document. The two are therefore causally ordered, and a row with no frame
  has no evidence coming. At start, `makeVerifiedExecutionOriginal` opens the frame against
  the current ledger, binds session, Turn, `userId` and config to the signed row, and returns
  the signer. The existing `authorizeExecution` then applies current membership, device state
  and sharing.
- **Separate map.** `rpcDispatchOriginals` is compared strictly, and promotion adds `resume`.
  Reading a queue frame from it would make a CLI without this change deny the Turn.
- **Comparison.** `queuedInputEvidence` is the canonical form of what the author chose. It
  excludes `resume`, which promotion takes from Session metadata and the signed row covers, and
  treats absent and empty MCP selections alike. It includes `_lodyAutomation`.
- **Machine input.** Automation is the only caller of the CLI's `pushMessageQueue`; Schedule
  capacity dispatch reaches the queue through it. It records a digest in
  `execution-origins.sqlite` before the write, and the start compares it with the signed row.
  A row carrying `_lodyAutomation` ignores `queueDispatchOriginals` and needs this receipt.
- **Requester.** `userId` remains unsigned by ledger identity, and no crypto-to-account mapping
  exists on the machine. Host-scoped credentials and identity follow the machine account, so
  `claim` refuses a turn that names that account unless its principal is `owner`. This applies
  to every encrypted start, because a directly written row reaches the same consumers.
- **Sending.** An encrypted queue send waits past the 200 ms preparation deadline, up to
  `QUEUED_ORIGINAL_DEADLINE_MS` and the caller's signal, because it cannot proceed without the
  frame. If no frame arrives, the input is not sent and the sender sees that.
- **Editing and removal.** Originals are immutable per Turn, so an edit that changes the input
  takes a new `userTurnId`, `operationId` and timestamp. Toggling the editing flag does not. An
  edit, a removal and a failed queue write delete the Turn's stored frame.
- **Scope.** A direct history row is unaffected: its signer is its author. The client's steer
  path writes its own row, and refusal only changes status. This covers the queue part of the
  execution-origin proposal in [#2344](https://github.com/LodyAI/Lody/pull/2344), which remains
  open for the rest.

## Alternatives

- *Refuse at promotion.* A refused row would need its own terminal path and could stall the
  queue, and every promotion route would need the check. The start gate already has one
  visible refusal path.
- *Sign nothing new and trust `queuedItem.userId`.* That field is display data.
- *Use the frame's config in place of the row's.* It would hide a mismatch rather than refuse it.
- *Map the verified signer to an account.* The machine has no such directory, and the ledger
  user ID is not an account ID.

## Consequences and limits

- Queued rows written by a client without this change have no frame and are refused at start.
  Web and mobile get this through their `lody-oss` revision, so that update must ship with the
  CLI. Rows queued before an upgrade behave the same way.
- A queued input keeps its original 15-minute window, as before.
- Frames grow the Session document, as `rpcDispatchOriginals` already does; nothing is pruned.
- A request signer unknown to a stale ledger is refused rather than retried.
- A frame stays valid for its signer until its deadline, and deletion from a shared document
  does not revoke bytes another reader kept. A queue row reusing it is bound to the signed
  content and Turn, not to the row's writer, and the journal still allows one start.
- `userId` is checked only against the machine account. Two other members' labels are not
  distinguished at start, and `resume` still comes from Session metadata.

## Verification

`apps/cli/tests/e2ee-runtime.test.ts` ("encrypted queued input evidence") runs a real ledger,
signed originals, watcher promotion and the start claim for member, owner, unshared, removed,
revoked, unsigned, changed and machine-authored input, later row edits, client-written markers,
requester labels and automation provenance, plus derivation origins.
`packages/components/tests/legacy-session-send-migration.test.ts` pins client ordering,
refusal, deadlines, cleanup and editing. No real backend, device or mobile run was made.
