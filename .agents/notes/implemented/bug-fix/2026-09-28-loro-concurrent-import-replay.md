# Avoid full-history replay on concurrent Loro imports

Status: implemented
Translation: current
Related: [中文](2026-09-28-loro-concurrent-import-replay.zh.md)
Pull request: [#1098](https://github.com/LodyAI/Lody/pull/1098)

## Abstract

Lody 0.100.0 users reported renderer stalls during concurrent Loro updates. In Loro 1.15.1, a criss-cross history can make `find_common_ancestor` fall back to the original fork point; replay then rebuilds each changed Text/List tracker from the start of document history. Lody upgrades to `loro-crdt` 1.16.3, which includes upstream fixes `d9ddfba19` and `80a0e8821` to select a recent multi-head replay base and replay register-only imports from the current version. A supplied local benchmark reports 500 ms to 4 ms; the exact documents and containers from the reported user incident could not be confirmed.

## Decision

Pin the shared catalog and CLI dependency to 1.16.3. `@loro-dev/loro-cli@0.6.0` declares an exact `loro-crdt@1.15.1` dependency, so a package-scoped pnpm override keeps one copy of 1.16.3 in the lockfile. The inspected peer ranges for `loro-repo@0.21.0`, `@loro-dev/streams-crdt@0.16.0`, `loro-mirror@2.3.2`, `loro-adaptors@0.6.1`, and `loro-websocket@0.6.2` accept 1.16.3. The exact pin is added to pnpm's release-age allowlist because the repository's seven-day quarantine had not elapsed at install time.

## Upstream behavior and API review

- `d9ddfba19` changes replay-base selection to use the latest multi-head critical version, avoiding replay from an old fork point for the reported criss-cross shape.
- `80a0e8821` allows register-only concurrent imports to replay from the current version.
- The 1.16.0 changelog also notes bounded decoded-container cache memory, faster shallow snapshot export, rejection of updates concurrent with a shallow root, and new container bulk deep-read APIs. The container `getDeepValueWithID()` API returns `cid` as the canonical container ID rather than a debug composite. Lody production code does not call this container API or parse its `cid`; one test helper calls the existing document-level `LoroDoc.getDeepValueWithID()`. Existing production calls to `LoroDoc`, Text/List/Map containers, import/export, and version vectors use APIs present in 1.15.1.
- 1.16.3 additionally rejects inserting a container attached to another document. This tightens invalid cross-document insertion behavior; Lody uses existing APIs without relying on cross-document container insertion.

## Evidence and limits

Upstream tags `loro-crdt@1.15.1` and `loro-crdt@1.16.3` include both replay commits. The supplied local benchmark used 40 Text and 40 List containers with 2,000 cross-sync rounds and measured a concurrent import at 500 ms on 1.15.1 and 4 ms on 1.16.3; those figures were provided with the request, not rerun here. We could not inspect the affected user's exact document, container mix, or renderer trace, so the connection between that specific report and this upstream path remains unconfirmed. Verification results are recorded in the PR.
