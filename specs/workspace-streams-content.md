# Workspace Streams content boundary

Status: draft
Translation: current

[中文](workspace-streams-content.zh.md)

An ordinary workspace continues using the existing transport factory while a future
protected caller can supply content handling. This seam does not enable E2EE, discover
a persisted workspace mode, or establish device permissions.

## Contract

- Omitted content configuration and explicit `plaintext` preserve stream names,
  authentication, length-prefixed updates, shared snapshot codec, upload defaults and
  repository persistence. Data becomes durable before its cursor advances; Meta/Flock
  checkpoints stay bound to the replica that loaded them.
- `protected` requires a trusted logical namespace, SDK room resolver and explicit
  snapshot upload admission. Every Meta, Loro document and named Flock room must select
  protection. Unknown modes, missing configuration and plaintext decisions fail closed.
- The SDK binds namespace and logical room to provider AAD. The caller supplies identity
  from trusted application state, never packets or routing URLs, and owns provider/key
  lifetime. This factory does not fetch keys or interpret permission logs.
- One provider handles updates and snapshots. The optional codec only compresses before
  protection and decompresses after verification; it defaults to the existing shared
  codec. SDK `canUpload` gates best-effort publication, receives no room context, and is
  not server admission.
- Verification/import/save failures retain SDK errors and checkpoint behavior. Do not
  skip rejected bytes, advance past unsaved state, or substitute plaintext. This seam
  adds no workspace-wide shutdown or recovery policy.

## Open decisions and limits

Whether a document verification failure stops one document or the whole workspace remains
undecided. Persisted mode discovery, legacy-client exclusion, real missing-key states,
cryptography and server snapshot admission are separate work. The current SDK sanitizes
provider errors and retains `payload_protection_error` in the repository error message,
but maps its repository error code to `internal`.

## Evidence

- [Factory](../packages/components/src/providers/workspace-streams-transport.ts)
- [Behavior tests](../packages/components/tests/workspace-streams-transport.test.ts)
- [Decision](../.agents/notes/implemented/architecture/2026-10-10-workspace-streams-content.md)
