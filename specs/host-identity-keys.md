# Host identity key lifecycle

Status: draft
Translation: current

[中文](host-identity-keys.zh.md)

A desktop may close while its CLI continues working. They use separate personal
and machine identities; background work must not acquire personal management keys.
The trusted host owns account/device binding and exposes only operations with a
specific purpose. Login alone does not prove possession of a device key.

The first interface creates an identity explicitly or reads an existing identity
against expected Ed25519/X25519 public keys. Create is insert-only, followed by
fresh readback of both public keys. Missing reads never generate replacements.
Uncertain write results require reconciliation, including cancellation after a
write. Public inspection can discover that existing identity without enrolling or
authorizing it. Failure must preserve saved material; no silent raw-key file fallback.
Authentication failure does not uniquely identify lock, rejection or corruption,
so errors retain unknown reasons unless the host has stronger evidence.

The interface exports public identities only. General private-key export and
arbitrary-data signing are outside the product contract. Purpose-specific crypto
operations will bind trusted protocol context in a later change. Personal lock
screen behavior, scoped operation handles and explicitly authorized unattended
machine operation still need implementation. Storage capabilities alone must not
be advertised as those guarantees or hardware key execution.

Key lifetime is independent of normal caches and logout. Local document/cache
application encryption is outside this change. This interface has no product entry
point and does not meet the all-platform Beta requirement.

## Evidence and outstanding work

[Package contract and native fixture](../packages/platform/README.md).
The macOS fixture tests isolated native storage and software cryptography only.
Shipping macOS integration awaits the crypto contract and signed-host validation.
Windows/Linux, Web, iOS and Android need their own adapters and real-device evidence.
