# Extend the workspace Streams factory for protected content

Status: implemented
Translation: current

[中文](2026-10-10-workspace-streams-content.zh.md)

## Abstract

The renderer factory already accepts authentication but previously fixed content and
snapshot configuration. It now accepts the published SDK's room protection resolver,
snapshot codec and upload gate, keeping ordinary wire formats and durability barriers.
Required protection rejects incomplete configuration and per-room plaintext selections.
This seam uses synthetic providers in tests; product E2EE and server admission remain
separate, and the scope of stopping after verification failure is still undecided.

## Decision

Use the existing published SDK interfaces without a dependency change or copied
synchronization. Initial validation used `loro-repo` 0.21.1, `streams-crdt` 0.16.1 and
`streams-client` 0.8.0. Rebasing onto main after [#1395](https://github.com/LodyAI/Lody/pull/1395)
inherits its 0.21.2 / 0.16.2 / 0.9.0 versions and preserves its factory diagnostics.
`content` is factory configuration, not a server workspace DTO;
ordinary runtime callers stay unchanged. Protected callers supply a trusted namespace,
total room resolver and explicit `snapshotUpload.canUpload`. The SDK owns encrypted-only
reads/writes, logical-room AAD, import and checkpoints; callers own providers and keys.
The codec handles compression, not verification.

A generic plugin registry or unused capability types add no required behavior. Retain
the original persistence construction and the compatibility boundaries from the earlier
[Streams upgrade](../bug-fix/2026-09-27-streams-crdt-0.16-upgrade.md).
The [draft contract](../../../../specs/workspace-streams-content.md) records this interface.

## Verification and limits

The owning suite runs real Loro/Flock and IndexedDB storage on fake-indexeddb against a
byte-only HTTP fixture, with signals/fake timers. It checks independent replicas after
offline edits, raw framing, snapshot import/publication, Meta/Flock checkpoints, actual
failed storage saves, verification rejection without cursor advancement, retry, and a
reader reconnecting without local writes. Its reversible provider checks SDK AAD plumbing
only and is deliberately not cryptography.

Focused validation: 24 factory tests and 56 adjacent cursor/runtime/router tests pass
on both the original dependencies and the rebased main versions.
Components source plus this test file typecheck; scoped type-aware lint, formatting and
`pnpm run docs check` pass (existing documentation warnings remain).
On the original dependencies, the full components suite passes 5,032 tests. Root `pnpm format`, typecheck, lint and
boundary checks pass. Full `pnpm check` is not green: the unchanged CLI native SSH
submodule fixture fails with the environment's Git helper `context_unreadable`, also
reproduced in isolation (5 passed, 1 failed). Sandbox IPC failures disappear with
socket permission (9 passed); no unrelated Git code was changed.
The rebased full check passes typecheck/lint and reproduces the same CLI failure
(3,658 passed, 1 failed, 4 skipped); that failure interrupts the other test groups.
Rebased formatting, source/test typechecking, documentation and boundary checks pass.
PR CI exposed a race in the reader-rejoin fixture: automatic retry could reopen SSE
before the writer's next save, while the byte fixture only sends backlog on connection.
A controlled-clock reproduction retained the old reader value. The test now holds
retry timers until explicit rejoin and observes the reader before publishing; it does
not change production retry behavior or increase timeouts.
The corrected test passes with the 80 focused cases and all 1,730 cases in the
previously failing components shard (184 files).

The SDK upload gate has no room parameter and is not server admission. Repo retains the
sanitized `payload_protection_error` message and coarse `internal` error code. Main's
0.21.2 upgrade additionally preserves safe Streams context and explicit retryability.
The upstream `encodeStreamsRoomAdditionalData` helper and readonly
`payloadProtectionReason` field were inspected in source but are not consumed here;
their release and dependency adoption remain separate work. Trusted host snapshot
admission must bind the same namespace and logical room AAD via the upstream helper,
not duplicate the encoding in this factory or trust uploaded identity fields. The
core's `bindAdditionalData` integration is outside this factory's test acceptance.
No new failure-scope policy, key service, persisted mode, production creation entry,
server storage change or full runtime rewrite is included. Real encrypted-core integration
and live/packaged platform acceptance remain separate.
