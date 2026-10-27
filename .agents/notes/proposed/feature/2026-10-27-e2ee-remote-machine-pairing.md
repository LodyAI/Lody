# Remote encrypted machine pairing

Status: proposed
Translation: current
Date: 2026-10-27

[中文](2026-10-27-e2ee-remote-machine-pairing.zh.md)

## Abstract

A remote machine needs explicit desktop approval without receiving an account API key. This candidate adds a signed expiring command, public-material comparison, a cancellation fence shared with ledger submission, and activation of an independently scoped machine credential. It reuses retained machine proofs and verifies the approving frontend against the original command before installing a current key. A dedicated startup mode connects only that encrypted workspace. This is a product-flow candidate; installed-platform and deployed-service acceptance remain separate.

## Trust and ownership

The person transfers the command from the desktop to the intended machine. Its signature covers account, workspace/genesis, initiating personal device, membership, random session, endpoints, expiry and one-time secret. The command is the independent pin input; a relay response cannot replace it. Both screens hash the complete machine public material, credential binding, protection class and command scope. A separate approval action checks the displayed digest against retained material. File custody is disclosed before approval.

The desktop account runtime serializes the separate remote approval journal under its existing native owner. Local pairing keeps its own tables. The remote journal retains the exact offer and signed admission before HTTP, and archives originals after a terminal server result plus locally verified settlement, or an explicit cancellation receipt proving no writer reservation exists. The latter also covers signing that finished before a failed dispatch. Expired commands whose initial server begin was lost receive a terminal receipt on retry so they can be retired. A new session always requires fresh consent. An already admitted device is confirmed with its existing credential, possession proof and session-bound credential signature, without another ledger entry.

CLI preparation and installation retain their existing custody owners. The command owns polling and aborts its HTTP/waits on cancellation; native custody work settles before its scope closes. Network failure preserves all originals for the same-command retry. A dispatched admission cannot be cancelled or replaced because its deadline elapsed. The backend writer transaction reserves the remote session, and verified settlement commits projection, credential activation and session outcome together. Unknown results reuse the exact request and record.

## Service access and running

The machine generates and protects a random per-workspace credential before preparation; only its hash is relayed. The backend activates it as a machine service credential after verified admission (or explicit confirmation of the same active device). It is never a Better Auth API key. Each narrow request derives its account from that grant and checks workspace/genesis, the bound active device/machine/member, account and workspace deletion fences, and projection/checkpoint agreement. It cannot authenticate ordinary account APIs or manage the workspace.

The service credential has no timed expiry; revocation, replacement or membership removal makes every subsequent device request fail. Content tokens retain their existing 15-minute maximum. Machine discovery returns only the bound encrypted workspace and publishes revoked access to Fleet. `lody start --paired-workspace <account/workspace>` verifies device-signed routing metadata before reopening the existing protected credential and activation marker, disables ordinary catalog bootstrap, and constructs a restricted cloud port with no ordinary transports, account API key, billing, hosted GitHub, notifications or telemetry capability. Pairing starts this mode automatically; the same command printed in the terminal supports restart. Encrypted RPC/execution still obeys the separately implemented channel capabilities; pairing never enables plaintext fallback.

## Location

Only the private Worker reads trusted `request.cf` country/city and signs the forwarded body through the existing service-auth channel. Client location fields and IP headers are not accepted as evidence. The backend stores no raw IP and uses no third-party lookup. Location is bounded, marked estimated, and may be unknown or describe a VPN/relay. Completion, cancellation, conflict and scheduled expiry clear it; an admitting write retains settlement evidence after expiry but loses location.

## Dependency and verification limits

Ledger machineId/proof/replacement encoding belongs to the separate machine-ledger change, and recovery changes remain separately owned. This PR does not carry those changes. The remote backend rejects older machine records instead of weakening the ledger format. Local validation composes the dependency only temporarily, then restores the main-based diff.

Behavioral verification and exact heads are recorded in the draft PR. Synthetic crypto/SQLite, deterministic handler fixtures and a signed Worker forwarding test do not prove real keystores, two physical machines, gateway deployment, package builds or product acceptance. No merge or deployment is part of this work. The existing Promise command/custody facades remain temporary application boundaries; this change does not claim a Fleet or workspace Effect migration.
