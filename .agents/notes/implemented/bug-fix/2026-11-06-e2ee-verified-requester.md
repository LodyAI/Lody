# Verified requester in encrypted workspaces

Status: implemented
Translation: current

[中文](2026-11-06-e2ee-verified-requester.zh.md)

## Abstract

An encrypted turn's `userId` is a display label on a history row, but execution used it as the
requester for MCP, Git identity, Inbox and delegated access. A start now derives its requester
from the verified signer: the machine account for this machine's owner, and
`e2ee-member:<cryptoUserId>` for any other member. Delegated access on an encrypted daemon is
decided locally from the verified ledger and the owner-signed sharing policy, with no workspace
service call. The label stays for names and commit attribution. No ledger format or server
change is involved.

## Decision

The owner decided on 2026-11-06 that these checks run locally: "刚刚的问题直接改成本地验证，不要去
服务端走一圈了". That rules out a server account mapping.

- **Identity.** `resolveRequester` maps a verified signer to its requester. A row this machine
  signed keeps the requester it wrote, which automation admission depends on. A derived input
  runs as its origin member.
- **Entry points.** The watcher resolves the requester before building a request, and the
  service resolves it for direct and prepared starts. `claim` refuses a start whose requester
  differs, so a path that skipped resolution fails closed.
- **Access.** `verifyRequesterAccess` reuses `authorizeExecution`, the same check a turn start
  passes. Every encrypted `verifyMachineAccess` call in `MessageHandler` goes through it, and so
  do `session` commands, Operation targets and `project list --machine` on a daemon, delegated
  or not. The workspace service refuses encrypted workspaces, so these could not work on an
  account-signed-in daemon before. Another machine is reachable only as this machine's owner,
  matching the same-machine rule for derived work. A command passing this check gains no
  authority: the start claim still decides.
- **Device control.** iOS and Android agent control share one gate on the verified principal.
- **Label consumers.** `humanInputReceipts` and device control no longer compare the label on
  encrypted turns. The RPC offer no longer accepts Inbox input under its label, because dispatch
  accepts it under the verified requester.

## Alternatives

- *A service mapping from crypto user to account.* Rejected by the owner, and it would make the
  mapping server-trusted.
- *Dropping the affected member features.* Rejected by the owner.

## Consequences and limits

- A start resolves its signed original once more before the claim.
- Inbox continuations, goal control and edit-and-resend resolve a commit name from the requester.
  For a member this falls back to a synthetic profile, not the row's label.
- Automation on a row labelled with an account other than the machine's keeps that label, and its
  delegated access is denied.
- `verifyRequesterAccess` checks a member through one current personal device.
- One-shot commands outside a daemon keep their existing authenticated access path.

## Verification

`apps/cli/tests/e2ee-runtime.test.ts` covers mislabelled requesters, owner and member identity,
local shared and unshared access with no service call, and cross-machine access.
`apps/cli/tests/session-dispatch-watcher.test.ts` covers the built request, and
`apps/cli/tests/session-execution-service.test.ts` covers production composition. No real backend,
device or mobile run was made.
