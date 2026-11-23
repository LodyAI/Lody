# Device-authenticated epoch staging adapter

Status: proposed
Translation: current

[中文](2026-10-26-e2ee-epoch-staging-adapter.zh.md)

## Abstract

An epoch publication must survive losing the publishing device after commit. Core already owns candidate protection, complete-group staging, exact readback and original-record reconciliation. This change supplies the optional cloud request contract and a host-only transport adapter, using the existing bound device credential instead of an extra request signature. It does not enable rotation UI, sending barriers, remote authentication or any staging runtime caller; those remain separate integration and acceptance work.

## Responsibility and recovery

`EpochStagingStore` remains storage, never ledger authority. Cloud requests carry `workspaceId`, `credential` and optional `cliToken`; stage/delete need no new signed proof. Host signature utilities remain available for other hosts' optional verification tier. The server authenticates the bound device and applies its current projection. Clients still verify publication originals, eligibility, signatures, HPKE and commitment before installing keys. A returned group must match the requested complete locator.

Electron main's existing request owner supplies request-local auth, cancellation, disposal and the 30-second deadline. Staging snapshots access and all input originals before yielding; rerunning the same Effect resends those bytes. There is no network or shared workspace lock. A timeout or lost acknowledgement is unknown, leaving core's durable originals available for explicit reconciliation. Aborting or disposing rejects late responses without retiring unrelated workspace requests.

Delete sends one physical cleanup page. `done: false` returns retryable `BackendError(unavailable)`; it neither reports completed cleanup nor loops. The caller retains the same locator and occupied commitment for a later call. Cleanup cannot rewrite an already confirmed publication result. Pure structural decoding and bounded typed errors prevent raw SDK causes or credentials crossing IPC or telemetry.

Server `e2ee_staging_invalid` and `e2ee_staging_corrupt` refusals map to terminal `BackendError(invalid-response)`, matching malformed-reply handling; they must not be retried as network unavailability. A later corrected request remains usable. Capacity conflict, timeout and incomplete-cleanup semantics remain distinct.

## Evidence and limits

Core's existing real SQLite/crypto rotation suite exercises staged readback, unknown CAS outcomes, publisher loss and conflict cleanup. Added `checkEpochStageRequest` comparisons distinguish valid historical outer signatures from current-epoch authorization and reject tampered signatures, context and originals. Injected HTTP responses, explicit signals and TestClock exercise fixed wire originals, lost acknowledgements, cleanup progress, malformed replies, cancellation, slow successful requests and recovery after deadline; no real network or keychain is used.

Backend publication references and retention must be installed independently before product activation. The older atomic-removal draft's mandatory adapter signatures are superseded for Lody Cloud by the backend guide's required tier; this note does not approve or change that draft. Member self-revocation succession, trusted freshness, remote identity, complete rotation barriers and installed application acceptance remain outside this slice.
