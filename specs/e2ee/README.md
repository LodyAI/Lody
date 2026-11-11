# E2EE architecture and protocol drafts

- [Security whitepaper](whitepaper.md) · [中文](whitepaper.zh.md)
- [Permission ledger and interactions (Chinese)](permission-ledger.zh.md)
- [Implemented public foundation contract](../e2ee-foundations.md) · [中文](../e2ee-foundations.zh.md)
- [Web/mobile custody](client-custody.md) · [中文](client-custody.zh.md): platform trust, installation and original-byte ownership; not product activation.
- [Machine sharing](machine-sharing.md) · [中文](machine-sharing.zh.md): owner-only, per-project sharing of a member's machine (approved).
- [Execution freshness during a backend outage](execution-freshness-outage.md) · [中文](execution-freshness-outage.zh.md): longer local windows when the latest ledger read gets no answer (approved, not yet implemented).
- [Invitation trust](invitation-trust.md) · [中文](invitation-trust.zh.md): email invitations trust the server until verified; self-delivered links carry a secret the server never sees (draft).
- [Control-plane availability](control-plane-availability.md) · [中文](control-plane-availability.zh.md): Owner abandons unusable epochs, self-service record quota, low-order key rejection (draft).
- [Migration ownership and validation](../../.agents/docs/e2ee-migration.md) · [中文](../../.agents/docs/e2ee-migration.zh.md)

These Specs describe intended architecture and retain explicit unresolved decisions.
They do not enable product E2EE or approve unfinished protocol formats.

Recovery: [recovery vault](recovery-vault.md), approved. The [permission ledger](permission-ledger.zh.md) has a limited approval scope.
