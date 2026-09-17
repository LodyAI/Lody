# Independent E2EE demo package

Status: proposed
Translation: current

[中文](./2026-09-16-e2ee-independent-demo.zh.md)

## Abstract

Product E2EE wiring is paused. The executable proof is now the local
`packages/e2ee-lab` adversarial lab; the earlier `packages/e2ee-demo` UI/game
delivery was removed after its host/session coverage moved into the lab. Original
intent: a local-only demo on the current `feat-e2ee-core` branch, with a loopback Node
host, official SQLite Riverrun on an explicit data directory, and isolated
browser clients that consume public `@lody/e2ee-core` and streams-crdt APIs.
This is not Lody integration, V4, or production enablement. Registry
`streams-crdt@0.15.1` lacks snapshot `continuationOffset`, so the demo pins a
recorded local tarball instead of a sibling source alias.

## Decision and scope

- Develop in this workspace and branch. Do not create `codex/e2ee-demo`,
  `examples/e2ee-demo/`, or a long-lived `/tmp` tree.
- Core does not depend on the demo. The demo does not import Electron, Convex,
  or Cloudflare.
- Control writes verify signatures and current permission, then CAS. Exact
  pending bytes persist before CAS; dropped ACK confirms by read-back without
  re-signing. Pending is not committed authority.
- HTTP credentials store the original `expiresAt`. Cache, queue, and restart
  must not extend it. `now == expires` is expired.
- Historical admitted snapshots remain readable after later revoke. Revoke does
  not erase epoch keys already delivered.
- Recovery backup v2 seals the R secret and epoch key map with
  `sealRecoveryBackup`. Restore admits a new device as `committed` and decrypts
  prior ciphertext. Do not invent a dummy identity or store R as plaintext.
- Digest mismatch is `conflict` / `inconsistent`, never `checked`.
  `pending-sync` is not agreement. Server-hosted notes are `untrusted`.
  `checked` only comes from independently imported notes (paste/QR), and not
  from the original space creator's note.
- `/ds` writes use an explicit allowlist. Ordinary POST/DELETE on control or
  keys is rejected. Unjoined devices cannot append garbage to the ledger.
- Browser sessions persist device keys, genesis, epoch keys, and pending CAS
  bytes in origin storage (localStorage) or a process map in Node.
  `transaction.save()` writes the journal before it returns; a persist failure
  blocks CAS. Closing during an in-flight append recovers the exact pending
  bytes without re-signing.

## Limits

Production JWT/gateway `60610126` lives in another tree; the demo enforces the
deadline on its own Node path. Demo completion is not product enablement.
Registry `streams-crdt@0.15.1` still lacks `continuationOffset`; the demo keeps
the pinned tarball. `appendWriteOnly` cannot run on a StreamsCrdt instance that
already called `sync()`.
