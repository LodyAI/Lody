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
