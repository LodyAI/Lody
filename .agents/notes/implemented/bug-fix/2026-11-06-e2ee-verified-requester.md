# Verified requester in encrypted workspaces

Status: implemented
Translation: current

[中文](2026-11-06-e2ee-verified-requester.zh.md)

## Abstract

In an encrypted workspace, a turn's execution identity comes from its verified signer, and a
history row's `userId` is display data. The requester is the machine account for this machine's
owner and `e2ee-member:<cryptoUserId>` for any other member. Machine access on an encrypted
daemon is decided locally from the verified ledger and the owner-signed sharing policy. No ledger
format or server change is involved.

## Decision

- **Identity.** `resolveRequester` maps a verified signer to its requester. A row this machine
  signed keeps the requester it wrote, which automation admission depends on. A derived input
  runs as its origin member.
- **Entry points.** The watcher resolves the requester before building a request, and the
  service resolves it for direct and prepared starts. `claim` refuses a start whose requester
  differs, so a path that skipped resolution fails closed.
- **Access.** `verifyRequesterAccess` reuses `authorizeExecution`, the same check a turn start
  passes. Encrypted `verifyMachineAccess` calls in `MessageHandler`, `session` commands,
  Operation targets and `project list --machine` on a daemon go through it, delegated or not.
  Another machine is reachable only as this machine's owner, matching the same-machine rule for
  derived work. Passing this check grants nothing by itself: the start claim decides.
- **Device control.** iOS and Android agent control share one gate on the verified principal.
- **Labels.** `humanInputReceipts`, device control and Inbox use the verified identity on
  encrypted turns.

## Alternatives

- *A service mapping from crypto user to account.* Not used: these checks stay local.
- *Reducing member features.* Not used: members keep them on a shared machine.

## Consequences and limits

- A start resolves its signed original once more before the claim.
- A commit display name can still follow the label, or fall back to a synthetic profile, so it
  is not verified attribution.
- Inbox and Operation records stored under an earlier label scope are not migrated. They remain
  stored but do not appear in queries for the derived identity.
- Automation on a row labelled with an account other than the machine's keeps that label, and its
  delegated access is denied.
- `verifyRequesterAccess` checks a member through one current personal device.
- A one-shot command decides access from its own replica, for its own account. A machine with no
  usable ledger gets a clear error: `session` commands have no route to forward to the daemon.

## Verification

`apps/cli/tests/e2ee-runtime.test.ts` covers mislabelled requesters, owner and member identity,
local shared and unshared access with no service call, and cross-machine access.
`apps/cli/tests/session-dispatch-watcher.test.ts` covers the built request, and
`apps/cli/tests/session-execution-service.test.ts` covers production composition. No real backend,
device or mobile run was made.
