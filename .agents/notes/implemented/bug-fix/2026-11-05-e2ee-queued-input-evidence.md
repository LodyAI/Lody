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
  The existing signed-row check covers it, so it cannot be removed afterwards.
- **Human input.** The client stores the frame in `queueDispatchOriginals`, before the queue
  row, in the same document. The two are therefore causally ordered, and a row with no frame
  has no evidence coming. At start, `makeVerifiedExecutionOriginal` opens the frame against
  the current ledger, binds session, Turn and config, and returns the signer. The existing
  `authorizeExecution` then applies current membership, device state and sharing.
- **Separate map.** `rpcDispatchOriginals` is compared strictly, and promotion adds `resume`.
  Reading a queue frame from it would make a CLI without this change deny the Turn.
- **Comparison.** `queuedInputEvidence` is the canonical form of what the author chose. It
  excludes `resume` and automation markers and treats absent and empty MCP selections alike.
- **Machine input.** Automation is the only caller of the CLI's `pushMessageQueue`; Schedule
  capacity dispatch reaches the queue through it. It records a digest in
  `execution-origins.sqlite` before the write. Neither `userId` nor the machine signature
  decides.
- **Sending.** An encrypted queue send waits past the 200 ms preparation deadline because it
  cannot proceed without the frame. If no frame can be made, the input is not sent and the
  sender sees that.
- **Editing.** Originals are immutable per Turn, so an edit that changes the input takes a new
  `userTurnId`, `operationId` and timestamp. Toggling the editing flag does not.
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

## Consequences and limits

- Queued rows written by a client without this change have no frame and are refused at start.
  Web and mobile get this through their `lody-oss` revision, so that update must ship with the
  CLI. Rows queued before an upgrade behave the same way.
- A queued input keeps its original 15-minute window, as before.
- Frames grow the Session document, as `rpcDispatchOriginals` already does; nothing is pruned.
- A request signer unknown to a stale ledger is refused rather than retried.

## Verification

`apps/cli/tests/e2ee-runtime.test.ts` ("encrypted queued input evidence") runs a real ledger,
signed originals, watcher promotion and the start claim for member, owner, unshared, removed,
revoked, unsigned, changed and machine-authored input, plus derivation origins.
`packages/components/tests/legacy-session-send-migration.test.ts` pins client ordering,
refusal and editing. No real backend, device or mobile run was made.
