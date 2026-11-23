# Local file preview route and capability cache

Status: implemented
Translation: current

[中文](2026-09-29-local-file-preview-route-cache.zh.md)

## Abstract

Electron File Preview v3 already used the local `file/resolve-local` IPC path, but each request redundantly awaited target-plane resolution and reread the machine protocol capabilities from repo metadata. The runtime now uses an already-known route immediately and caches the small capability map per machine, while metadata changes invalidate that entry. File paths, file bytes, resource URLs, CLI authorization, and the no-cloud-fallback boundary remain unchanged; the measured scope is limited to renderer-side routing and metadata reads.

## Decision and evidence

`WorkspaceTargetRouter.getPlaneForMachine` is the authoritative fast path once local identity is known. `requestFilePreview` now calls the existing resolver only for an unknown route, so unresolved Electron targets retain the existing retryable error and remote machines still use Streams RPC.

Protocol capabilities are persisted in machine document metadata and are needed to negotiate `localFileResources`. The runtime keeps one declared capability map per machine, coalesces concurrent reads, invalidates it on any machine-document metadata event, and drops the cache on disposal. Missing capabilities are not cached, so an older or not-yet-synced machine is still treated as unsupported without delaying a later metadata update. The cache never contains file content, paths, or renderer-owned resource capabilities.

## Validation

The facade suite verifies that a known local route does not invoke route resolution. The runtime lifecycle suite verifies two local previews read machine capabilities once while still issuing two IPC preview requests. Both suites passed: 54 tests. Oxfmt and `git diff --check` passed. The package typecheck is currently blocked by unrelated missing Electron and ACP submodule dependencies in this checkout; documentation status reports existing missing links in uninitialized ACP submodules.
