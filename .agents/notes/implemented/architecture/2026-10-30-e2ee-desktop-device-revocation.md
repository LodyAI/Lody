# Desktop stops and cleans up a revoked device

Status: implemented
Translation: current
PR: [#2122](https://github.com/LodyAI/Lody/pull/2122)

[中文](2026-10-30-e2ee-desktop-device-revocation.zh.md)

## Abstract

The credential endpoint already returns the exact code `e2ee_device_revoked` when
this device's credential has been revoked. The CLI types it as
`CloudE2eeDeviceRevoked`, but the desktop folded it into a generic `unauthorized`
backend error. As a result, a revoked desktop kept its reader, transports and local
copy until token expiry, and could never confirm the loss. The owner decided that
the desktop treats this exact authenticated result like whole-member removal, with
three differences: the scope is this device's identity only, membership is
unaffected, and the user can pair the device again.

## Decisions

- **Classification.** Only the exact code becomes `E2eeDeviceRevokedError`. It still
  extends `BackendError` with reason `unauthorized`, so every other caller keeps its
  previous behavior. The rejected alternative in
  [member controls and local removal](../../proposed/architecture/2026-10-28-e2ee-member-controls-and-local-removal.md)
  still holds: a generic unauthorized response, an unclassified message, a network
  failure or an account problem never authorizes deletion.
- **Same receipt, same cleanup.** Every IPC site that handled member removal now
  passes either typed loss to `removeLocalWorkspace`, which receives an explicit
  reason. The host records the existing removal receipt; it is device-bound because
  it checks account, workspace, genesis, signing key and credential against the
  current identity. The host closes the workspace entry, and
  `cleanupRemovedDesktopWorkspace` erases only that account/workspace identity
  directory and forgets that one device in custody. Other workspaces, other
  accounts and the member's other devices are untouched.
- **Persisted reason.** An additive `revoked_devices` table holds the reason for the
  exact receipt row in the same SQLite transaction. Absence means whole-member
  removal, so existing receipts keep their meaning and no migration is needed.
  Opening and the in-flight cleanup fence report `e2ee_device_revoked`, not
  `member_removed`. The existing join install clears both rows only after it
  verifies a different retained signing key.
- **Renderer.** `e2eeAccessLoss` recognizes both exact native results. The content
  bridge stops seal/token/upload and retires the runtime through the existing
  member-removal path, which retains and runs the window-scoped IndexedDB cleanup.
  The workspace gate shows a device-revoked message with "Pair this device again",
  which opens the existing encrypted control page. That page classifies a revoked
  identity as `approval-required`, so it shows the existing pairing guidance. If
  revocation arrives while the page holds a reader, it cleans up and reopens
  instead of showing terminal removal.

## Live reader cut

Live J07/client and J08/client runs (2026-11-04) found two gaps after a
credential-confirmed loss in a still-running process. Stale read, seal and dispatch
calls lost their exact code: cleanup had removed the reader and the binding, so they
failed as an unprojected `e2ee_not_open` or `e2ee_missing-binding` and reached the
renderer as `e2ee_host_operation_failed`. And dispatch preparation is purely local,
so it kept succeeding after the server revoked the device; only a failed preparation
asked the server.

- **Exact refusal.** A sender without a reader is refused with the durable receipt's
  reason (`removedReason`) as its exact public code. Dispatch checks the receipt
  before the binding. The receipt is written only after a credential-confirmed loss,
  so this reveals nothing the renderer could not learn from `open`. Without a
  receipt the refusal stays the sanitized `e2ee_host_operation_failed`: publishing
  `e2ee_not_open` was tried and rejected, because unapproved-device status reads rely
  on that sanitized refusal and the loss oracle does not need it. Account-mismatch
  refusals keep it too: another account's receipt is not this renderer's fact.
- **Dispatch confirmation.** A prepared frame is returned only after this device's
  credential is confirmed with the credential-bound token endpoint. An exact loss
  records the receipt, discards the frame and returns the exact code. Any other check
  failure establishes nothing and returns the frame, as before; nothing is retried.
  The cost is one credential round trip per dispatch, the same one a failed
  preparation already made. The check starts beside the local preparation, not
  after it: the renderer races preparation against a 200 ms deadline, local
  preparation measured 10–60 ms, and a serial check made every live send miss the
  deadline. The deadline only bounds activation, so a preparation that answers late
  still stores its original and sends the dispatch for the already-activated turn.
  Raising the deadline was rejected because it is also the bound for refusing a
  known machine withdrawal before any write.
- **Reader hint.** Revocation keeps workspace membership visible, so nothing made
  a revoked window refresh. After recording a loss, main sends each reader window a
  reason-free `e2ee.accessLost` push; the renderer runs its existing native refresh,
  which returns the exact code and retires the runtime through the existing path.
  Carrying the reason in the push was rejected because it would create a second
  renderer loss path beside the refresh one. Periodic renderer polling was rejected
  because it costs a request per interval per window and still leaves a window.

Read and seal stay local and are cut at the next token, refresh or dispatch request,
not at the server's decision. Feature RPC preparation is not confirmed separately.

## Limits

This is honest-client cleanup, not secure erasure of copies made earlier. Issued
content tokens keep their bounded lifetime, as for member removal. On 2026-10-31 the owner approved
applying the retention exception to credential-confirmed revocation of this device;
the [desktop custody](../../../../specs/e2ee/desktop-custody.md),
[client custody](../../../../specs/e2ee/client-custody.md) and
[whitepaper](../../../../specs/e2ee/whitepaper.md) Specs state it, and the
[approval record](2026-10-28-e2ee-spec-approval.md#device-revocation-retention-exception)
gives the scope. Deleting on revocation is chosen because a lost or stolen device is
the main reason to revoke one; an accidental revoke costs only a resync, and edits
not yet sent could no longer be submitted with the revoked signing key anyway.
Stopping without deleting, or deleting after a delay, were rejected: both leave the
plaintext cache readable on a lost device. Tests use real SQLite, custody and IPC with synthetic cloud
results, plus component tests. No live server, packaged app or second-device
re-pair journey was run.
