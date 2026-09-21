# Honest-host ACL is a gateway in front of sqlite Riverrun

Status: implemented
Translation: current

[中文](./2026-09-18-e2ee-host-gateway.zh.md)

## Abstract

Cloud ACL for the E2EE lab belongs in a thin HTTP gateway in front of official sqlite Riverrun, not in Riverrun tables. Riverrun stores ciphertext and performs CAS; it must not decide Owner, Guest, or `canManage`. The lab host now re-reads the verified control ledger and applies membership, `deviceMayWriteDocument`, and `canSendEpoch`. Direct `riverrunUrl` access stays unauthenticated so malicious-server tests still exercise client defenses. This is the local stand-in for unimplemented production JWT/gateway wiring, not product E2EE.

## Decision

Whitepaper A5 already splits Streams completeness/CAS from JWT cloud access control. The lab had folded both into `startDemoHost`, then treated `credential.genesisHex == null` as unconstrained stream access.

The gateway (`packages/e2ee-lab/src/platform/gateway.ts`) is the honest-host authorization layer:

1. Issue an org-bound credential only when the device is on that Org’s current ledger. Possession proof alone yields an unbound login token.
2. For `/ds/` and member-only metadata, load the control stream through Riverrun, `Ledger.verify`/`extend`, then decide. Do not cache sticky membership for authorization.
3. Reads require current device membership. Content writes use `deviceMayWriteDocument`. Keys writes use exported `canSendEpoch`. Control CAS still checks the record signer equals the credential device and that `extend` succeeds.
4. Snapshot PUT keeps `createContentSnapshotPublication`. `mayWriteDocument` reads the request’s ledger from `AsyncLocalStorage`, not a process-global genesis.
5. Attack helpers keep writing `riverrunUrl` with no host ACL. A host 403 is not a client-integrity pass.

Host-meta SQLite (`credentials`, `spaces`, join/note mailboxes) is gateway state. It is not a second permission ledger.

## Rejected alternative

Putting role and membership columns into sqlite Riverrun. That would make storage a second policy engine, diverge from the signed ledger, and make malicious-server tests that xor or append Riverrun bytes no longer represent “bypass the permission layer.”

## Limits

Not a production JWT issuer. The 15-minute lease is still the worst residual window. Snapshot admission can still race a revoke during async signature verify. `open` still does not re-check current write, so guest/revoked ciphertext under a malicious Riverrun remains `outside-model`. Production gateway should reuse the same core predicates rather than a second role table.

Related lab work: [adversarial lab note](../../proposed/testing/2026-09-16-e2ee-adversarial-lab.md).
