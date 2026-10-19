# Refresh managed agent runtimes with immutable mirror artifacts

Status: implemented
Translation: current

English | [中文](2026-09-17-managed-runtime-refresh.zh.md)

## Abstract

The built-in Claude, Codex, and Grok adapters were pinned to older upstream runtimes, while Lody's managed-runtime manifests still addressed the matching older mirror objects. This refresh advances Claude Agent SDK to 0.3.274 with Claude Code 2.1.274, Codex to 0.154.0, and Grok Build to 1.0.34, then publishes immutable platform artifacts before changing the manifests. Kimi stays on its current Lody fork at the owner's request, and Pi stays unchanged because 0.85.1 is already current. The release-age quarantine remains enabled globally; only the exact newly verified Claude and Codex packages are exempted.

## Decision

Managed runtime upgrades remain an artifact-first operation:

1. Pin the adapter dependency or official runtime manifest to the selected upstream version.
2. Build or ingest every supported platform artifact from the official source and verify its source integrity.
3. Upload immutable versioned objects to the production R2 bucket and read them back to compare the pinned SHA-256 and byte size.
4. Update the CLI runtime manifest only after all required artifacts pass production readback.

Claude includes eight targets, Codex six, and Grok six. The pnpm seven-day release quarantine has exact exclusions for Claude SDK 0.3.274, its eight platform packages, and Codex 0.154.0; later releases remain quarantined. Grok's adapter-owned manifest pins 1.0.34, while its existing private-wire compatibility rules remain version-neutral because this refresh did not run an authenticated live session.

## Evidence

- Claude adapter: build passed; 823 tests passed and 20 were skipped.
- Codex adapter: build and typecheck passed; 637 tests passed and 27 were skipped.
- Grok adapter: build and typecheck passed; 58 tests passed.
- Claude and Codex production objects were read back from R2 and matched their generated manifests.
- Grok artifacts were reproducibly repacked from official npm packages, including executable hashes and sizes, then uploaded and read back under the immutable 1.0.34 prefix.
- Public HEAD requests returned the pinned byte size for all 20 production mirror URLs.
- The full root `pnpm check`, documentation check, formatting check, and frozen lockfile check passed. The root check was rerun outside the restricted sandbox because its local IPC suites require binding loopback and Unix sockets.

## Limits

Kimi was deliberately excluded from this refresh. Pi and the non-managed DSH adapter did not require new objects. A full workspace install reached Electron's native rebuild after resolving the new lockfile, but that rebuild cannot run on this machine until the local Xcode license is accepted; the adapter-level checks do not depend on that native build. Claude's standalone lint still reports the pre-existing unused `thinkingTokens` declaration in `src/tests/usage.test.ts`; this refresh does not change that file.

## 2026-10-13 incomplete upgrade rollback

Main commit `3d9b7cf1fe2872d8e5baa52916cf1cb1a0a6f0ea` advanced the Claude, Codex, Grok, and Pi gitlinks without updating the root lockfile, CLI SDK dependency, or managed-runtime manifests. CI at `567afa18d1f0d45ebbe78fca7dde2a5dde3a7536` failed frozen installation before tests. Updating only the lockfile would still leave Claude SDK 0.3.293, Codex 0.160.1, and Grok 1.0.46 inconsistent with the CLI's 0.3.284/2.1.284, 0.159.2, and 1.0.40 runtime contracts.

Restore all four gitlinks to the combination from `0b46cc2d8e33c6feafd08c00f51089456ab1e732`, whose CI succeeded. Retain the later registry refresh and all unrelated main changes. This restores dependency and runtime agreement without publishing new production artifacts or introducing release-age exceptions. The upgrade can return only with its complete dependency graph, matching SDK/manifests, and verified published artifacts; local build manifests are not production publication evidence. Frozen-lockfile and integrity checks remain enabled.

Validation: frozen installation, full `pnpm check`, formatting and format checks, documentation checks, and 113 GitHub automation tests passed. The CLI built with the required 2 GiB heap, passed published-bundle dependency/adapter smoke, and started with `--help` under an isolated data directory. All 20 restored canonical artifact URLs returned HTTP 206 to public range requests; this availability check is not a new integrity readback. The full check used the installed native Git helper path and CI's signing configuration: the session-injected broker helper otherwise makes one recursive SSH fixture fail with `context_unreadable`; all 18 Git transport tests passed with native helpers, and all 4119 CLI tests passed (4 skipped). Exact pushed-main Actions remain separate from this local evidence.

Public CI evidence: [failing main](https://github.com/LodyAI/Lody/actions/runs/38377855941), [successful rollback baseline](https://github.com/LodyAI/Lody/actions/runs/38370031341).
