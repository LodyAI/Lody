# Main IPC

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only. Parent main-process rules apply.

## Renderer authority

All product service classes extend `ProductWindowIpcService`. Register one-way product
messages through `onProductWindowMessage`; both admit only a registered product
window's trusted main frame. Packaged file URLs match exact renderer paths,
ignoring path case only on Windows after Windows path normalization. The trusted
recovery page may invoke only
`app.requestRendererReload` and `app.reportRendererFatalError`; it has no other
product IPC authority. Public browser views and preview frames have no product
IPC authority. Launch requests carry only a launcher id and absolute target path;
main resolves built-ins and natively approved, main-stored custom commands. Never
accept command specifications from a launch or probe request.
Default-application opening accepts only known document suffixes or ordinary
folders and opens the policy-checked real path. Unknown file types return
`unsupported_file_type`; Reveal and configured editors remain available. On macOS,
refuse bundle targets by their own name and documents inside ancestors with a
bundle suffix and an `Info.plist` marker; bundle-like repository names alone do
not block their documents.

## Personal-device approval

`E2eeIpc` keeps every `@IpcMethod()` with its input and sender/reader validation and
public failure projection, then delegates. Key delivery lives in
`services/e2ee-key-delivery.mts`; local-agent and remote-machine pairing orchestration
lives in `services/e2ee-agent-pairing-service.mts`. Those modules receive the validated
reader id and must not become renderer-facing.

Confirm the signed admission through ledger-only refresh before publishing its
invitation. Key distribution belongs to the existing account/workspace-bound main
owner and must not block the approval response. Register that delivery before the
publication await so reset or sign-out can stop it; a late publication result must
never recreate a stopped task. Invitation publication is not key receipt or content
readiness.

Capture a personal approval's account generation before its first await and its
original native owner on first access. Reset invalidates matching in-flight
approvals even without a delivery slot. Check that operation and owner while
registering delivery under the account lock; same-account re-login cannot revive
it. Retire the operation ticket on settlement without gating other workspaces.
Control-only senders receive a missing current key before distributing; failed
key delivery retains the approved admission and its bounded retry owner. Delivery
slots retain their login generation; starts, retries and result settlement cannot
borrow a later same-account login.

## E2EE access loss

Only parsed HTTP 560 codes `e2ee_member_removed`/`e2ee_device_revoked` from explicitly
credential-bound endpoints (content-grant action: also HTTP 200), or a fully verified
ledger view that no longer contains this device or membership, may produce
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

Dispatch checks the credential beside local preparation with a 50 ms waiter
budget for an unknown verdict. Latch an exact loss before its native cleanup:
slow cleanup cannot turn known loss into uncertainty or replace its exact code
with a local error. Return exact refusal without awaiting cleanup or an admitted
native read. The original native owner synchronously fences its binding, including
reset, and retains raw cleanup outside the account lock. Only verified terminal
erase releases that fence; a five-second diagnostic deadline or failed cleanup
never proves drain. Exact loss
discards the frame and records the receipt; unknown-verdict timeout or an
unclassified failure leaves the local result unchanged. The bounded network
request continues and records exact late loss, including the reader hint. Never
retry the check or replace a refusal with a fallback. Before returning a frame,
recheck the originating account generation, owner, reader incarnation and credential
binding; lifecycle cancellation always refuses the old frame.
A failed dispatch captured without a reader never returns a frame and awaits its
retained credential's existing bounded network request outside the account lock.
This diagnoses loss instead of substituting an unknown-verdict timeout; JWT or
transport uncertainty retains the original refusal. Live-reader sends keep the
50 ms budget. No second request or retry is added.
A sender without a reader is refused with the identity's recorded removal reason as
its exact public code. Without a receipt, and on account mismatch, the refusal stays
the untagged `e2ee_not_open`, which the boundary publishes only as the sanitized
`e2ee_host_operation_failed`. After recording a loss, main sends reader windows the
reason-free `e2ee.accessLost` hint; the renderer's own refresh learns the exact code.
[Rationale](../../../../../.agents/notes/implemented/architecture/2026-10-30-e2ee-desktop-device-revocation.md#live-reader-cut).
