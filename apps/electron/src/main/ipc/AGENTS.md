# Main IPC

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only. Parent main-process rules apply.

## E2EE access loss

Only parsed HTTP 560 codes `e2ee_member_removed`/`e2ee_device_revoked` from explicitly
credential-bound endpoints (content-grant action: also HTTP 200) may produce
`E2eeMemberRemovedError`/`E2eeDeviceRevokedError`.
JWT, transport, parsing and unrelated endpoint failures never authorize cleanup,
even with matching codes or types. The account boundary projects typed results,
including causes, to their exact codes with the `accessLoss` marker.
Revocation uses the device-bound removal receipt and cleanup, records its reason,
and remains terminal until re-pairing replaces the key. Failed local operations,
including dispatch, confirm loss through this device's credential.
Dispatch still requires its calling reader. Temporary status hosts drain outside
the account lock on every exit, including failed identity rechecks, unless another
reader owns them.
[Decision](../../../../../.agents/notes/implemented/architecture/2026-10-30-e2ee-desktop-device-revocation.md).

A prepared dispatch frame is returned only after this device's credential is
confirmed with the server; an exact loss discards the frame and records the receipt,
while any other check failure leaves the prepared frame unchanged. Never retry the
check or replace a refusal with a fallback. Start the check beside the local
preparation, never after it, because the renderer races preparation against its
dispatch deadline.
A sender without a reader is refused with the identity's recorded removal reason as
its exact public code. Without a receipt, and on account mismatch, the refusal stays
the untagged `e2ee_not_open`, which the boundary publishes only as the sanitized
`e2ee_host_operation_failed`. After recording a loss, main sends reader windows the
reason-free `e2ee.accessLost` hint; the renderer's own refresh learns the exact code.
[Rationale](../../../../../.agents/notes/implemented/architecture/2026-10-30-e2ee-desktop-device-revocation.md#live-reader-cut).
