# Minimal plaintext presence for encrypted workspaces

Status: proposed
Translation: current

[中文](2026-10-28-minimal-plaintext-presence.zh.md)

## Abstract

Disabling presence in encrypted workspaces hides machine, session and viewing liveness.
The selected approach reuses the ordinary ephemeral channel and its 90-second TTL,
with independent publish and receive allowlists limited to IDs, enums and timestamps.
Free-text details are excluded before either local origin store or cloud publication.
This exposes liveness metadata to the service while avoiding a separate encryption,
key-availability and replay pipeline; protected documents remain independent.

## Decision and boundaries

This supersedes the presence-disabled part of the
[M2 integration proposal](2026-10-22-e2ee-m2-product-integration.md).
The encrypted-presence implementation in [#1994](https://github.com/LodyAI/Lody/pull/1994)
is closed without merging. Presence metadata already overlaps what connections,
traffic and account identity reveal; its confidentiality benefit does not justify
another crypto lifecycle and its availability costs for this feature.

- Keep the existing Loro EphemeralStore adaptor, stable keys, room routing, queue,
  heartbeat and TTL. Use the encrypted workspace's authorized bucket and existing
  token owner; never substitute the ordinary bucket when that capability is missing.
- Shared minimal schemas independently enumerate IDs, `kind`, status
  `type`/`activity`/`phase`/`stage` enums, and `since`/`updatedAt`. Unknown fields are
  ignored, including `detail`, future text fields and malformed extra content.
  Known invalid fields discard only that entry.
- CLI creation selects minimal mode before writing either the local-origin or
  workspace store. Heartbeat republishing cannot recover stripped details. Cloud
  and local renderer snapshots both use the minimal receive parser. Viewing
  publication is explicitly allowlisted too.
- Ordinary presence retains its existing payload, parser and 90-second TTL. No
  content-bearing side channel is enabled by enabling presence. Presence is an
  untrusted liveness hint, never membership, identity or execution authorization.
- An unavailable/unjoined room stays unknown and cannot alone block dispatch.
  Protected document attachment survives a presence-attachment failure; the existing
  presence owner retains cleanup/recovery responsibility and emits a bounded warning.
  No new queue, timer, retry owner, key operation or synchronization fence is added.

The presence body codec from [#1990](https://github.com/LodyAI/Lody/pull/1990)
is not used or removed. Its later disposition is outside this change.

## Verification and limits

Deterministic regressions first failed for detail leakage, receive parsing, disabled
presence and the unavailable UI verdict. They now exercise real Loro encoding,
SDK POST bytes, server-style apply/encodeAll bootstrap, received extra fields,
local-origin republishing and ordinary payload preservation. CLI composition tests
check unknown before join and the joined online set; existing dispatch tests retain
unknown allowance and definite-offline refusal. Fake/injected clocks and explicit
signals avoid sleeps and network timing.

Affected tests, type/static checks and document checks are recorded in the PR.
A real deployed gateway, installed two-device behavior and packaged-platform
acceptance are not established by these local tests. The draft remains under review.
