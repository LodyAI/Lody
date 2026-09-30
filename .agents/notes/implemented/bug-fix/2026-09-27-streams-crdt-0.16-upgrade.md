# Upgrade the Streams client runtime to 0.16.0

Status: implemented
Translation: current

[中文](2026-09-27-streams-crdt-0.16-upgrade.zh.md)

PR: [LodyAI/Lody#1044](https://github.com/LodyAI/Lody/pull/1044)

## Abstract

Presence could queue obsolete same-key states behind a slow request, and a stalled token
callback could keep a request waiting indefinitely. This change pins streams-crdt 0.16.0
and its streams-client 0.8.0 dependency, using the existing built-in Loro adaptor at all
three construction sites. Tests exercise the actual frontend factory, real Loro stores,
and controlled HTTP responses to verify supersession, in-flight preservation, sync barriers,
and token-deadline recovery. This is a client upgrade; server retention, buffer capacity,
and TTL deployment are separate, and publisher rate/size limits still apply.

## Dependency decision

The catalog supplies `@loro-dev/streams-crdt` to CLI, components, and shared. Patched
`loro-repo@0.20.0` consumes it as a peer, not a bundled copy. Its declared range is
`^0.15.0`; a package-specific `peerDependencyRules.allowedVersions` entry admits only
0.16.0 after the API comparison and runtime checks below. The existing loro-repo patch
is unchanged. A blanket peer override or an unrelated loro-repo upgrade would conceal
a wider compatibility decision and is unnecessary here.

`@lody/loro-streams-rpc` directly consumes streams-client, so its catalog also moves to
0.8.0. The lockfile retains streams-client 0.7.0 only for the separate
`@loro-dev/loro-cli@0.6.0` development tool. All seven pinned ACP submodules were
initialized and their manifests/lockfiles inspected: none consumes these Streams
packages. No vendored Streams implementation or Streams patch was found. Exact
release-age exceptions allow these two explicitly requested releases without relaxing
quarantine for future versions.

## Compatibility evidence

Compared the official npm tarballs for streams-crdt 0.15.1/0.16.0 and streams-client
0.7.0/0.8.0, including all exported declaration entrypoints and emitted runtime code.
The release is [upstream PR #394](https://github.com/loro-dev/loro-streams/pull/394),
merge `ee6d7bcdcd625f85083894d75a2c53f17c139c87`.

- No consumed public API was removed. LoroDoc/Flock adaptor implementations and zstd
  entrypoints retain their contracts; the ephemeral adaptor gains optional
  `localUpdateKey` and an exported key reader. Client backward reads are additive and
  unused by this change.
- Snapshot protection now receives `continuationOffset`; bootstrap validates nonempty
  snapshot positions. Lody does not configure a payload-protection provider. Its real
  Loro snapshot bootstrap is tested both raw and zstd-compressed, with the existing
  shared codec and a valid snapshot continuation header.
- The HTTP client now bounds token/body waits, adds long-poll grace and SSE idle handling,
  rejects truncated multipart bodies, and discards incomplete SSE events at EOF.
  These are behavior changes, not a claim of whole-package semantic equivalence.
  RPC tests cover Lody's existing SSE/long-poll and request paths; hosted endpoints
  were not exercised.

## Presence integration

```text
CLI presence / CLI machine-monitor / frontend EphemeralRoomTransport
  -> EphemeralStoreAdaptor(real EphemeralStore)
    -> localUpdateKey(single-key set/delete)
      -> EphemeralStreamCrdt 0.16.0 serial queue
        -> request + unauthorized-token deadlines
```

These sites pass the adaptor directly; no custom adaptor capability needs forwarding.
Values are complete current state under stable keys, so a newer value may replace an
older unsent value. In-flight requests, unknown keys, and multi-key updates must not
be replaced. No concatenation or re-encoding is introduced. The production factory
regression sends an in-flight value, 100 obsolete same-key values, an independent
heartbeat, and a final set/delete: the peer sees three POSTs and the expected final
state. The sync barrier stays pending until the superseding value is acknowledged.
Explicit clocks order Loro timestamps; the test does not depend on mutations crossing
a real millisecond boundary.

`pendingLocalCount` still represents logical unacknowledged updates, including values
superseded in the queue, rather than HTTP request count. Existing diagnostics remain
valid under that interpretation. A joined room still does not prove fresh delivery.
This updates the current queue explanation in the [presence Spec](../../../../specs/loro-ephemeral-presence-channel.md)
and [CLI guide](../../../docs/cli-lib-loro-presence.md), extending the earlier
[publisher-budget decision](../architecture/2026-09-20-ephemeral-presence-channel-budget.md)
without removing its rate/size invariant.

## Validation and limits

Targeted checks cover components presence/monitor/recovery (25 tests), shared presence,
authentication and snapshot codec (45), CLI presence/monitor/session/document and relay
authorship (45), and RPC (119 passed; 3 opt-in service integration tests skipped).
Affected package typechecks, static boundary checks, formatting, frozen offline
installation, docs check, and the final full `pnpm check` pass. The full run includes
4,338 components tests, 3,097 CLI tests, 1,214 shared tests, and 119 RPC tests;
4 CLI and 3 service integration tests retain their existing skip conditions.

No production deployment or live presence acceptance was performed. Server room
retention, buffer 16, and server TTL 90s require a separate deployment. Existing local
presence freshness/TTL constants are unchanged.
