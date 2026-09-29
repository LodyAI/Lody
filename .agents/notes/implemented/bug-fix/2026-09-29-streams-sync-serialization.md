# Upgrade Streams CRDT to serialize explicit and live synchronization

Status: implemented
Translation: current

[中文](2026-09-29-streams-sync-serialization.zh.md)

PR: [LodyAI/Lody#1099](https://github.com/LodyAI/Lody/pull/1099)

## Abstract

Sending a message updates workspace metadata and immediately requests full synchronization while live synchronization may still be uploading that metadata. Streams CRDT 0.16.0 can reject this overlap with an internal error even when the live upload and independent message dispatch succeed. Lody now pins the published 0.16.1 fix, which serializes explicit synchronization with live uploads and keeps pending-batch acknowledgment and removal within the same queue transaction. Published-package regression tests pass; the specific production incident's original internal exception remains unavailable, so this does not establish that every synchronization failure has the same cause.

## Decision and evidence

Upstream [loro-streams#400](https://github.com/loro-dev/loro-streams/pull/400), merged as `060e5966fb3b9e973989a85e64198ed7e592963a`, fixes the race. In 0.16.0, live uploads hold `enqueueExclusive` while public `sync()` bypasses that queue. When a pending append is frozen, an explicit direct append can throw `pending local append must be finalized before direct append`; error normalization turns it into `internal_error`. Loro Repo's `syncMeta` wrapper hides the underlying message. Lody's `workspace-session-send-journal.ts` writes `latestUserMsgId` before calling `waitForTargetSync`, which requests `scope: 'full'` in `create-workspace-runtime.ts`. This provides the overlapping metadata operations. RPC dispatch can independently succeed.

Upgrade the shared catalog, exact release-age exception, and the package-specific `loro-repo@0.21.0` peer allowance to 0.16.1. Regenerate the lockfile with pnpm 10.20.0; CLI, components, shared, and Loro Repo's peer snapshots use the same version. Streams Client remains 0.8.0. No transport wrapper, error suppression, product contract, or submodule revision changes are needed. This continues the [0.16.0 upgrade](2026-09-27-streams-crdt-0.16-upgrade.md) with a focused upstream bug fix.

## Verification and limits

- Installed the npm-published 0.16.1 package in an isolated temporary test environment with Loro 1.16.3 and Flock WASM 0.4.3.
- Ran upstream `self-healing-loops.test.ts` from the fixing branch against published exports instead of source imports: 18 tests passed, including nine deterministic overlap/recovery scenarios. The binary-items fixture helper was retained unchanged. No live network or real sleeps are used by these tests.
- Ran upstream `flock-adapter.test.ts` against the published Flock export: 12 tests passed.
- Compared the published 0.16.0 and 0.16.1 declarations: index, Flock, Loro, and zstd entrypoints are unchanged after normalizing generated chunk names. The shared declaration chunk adds only private serialization helpers and comments.
- Lockfile regeneration changes only the selected Streams version, integrity, and its peer-qualified references. The nested checkout has no installed root dependencies, so full Lody typechecking/build and desktop end-to-end behavior were not verified here.
- Frozen offline lockfile validation, `pnpm run docs check`, and `git diff --check` passed. Required pre-commit commands were attempted: `pnpm check` stops during ACP adapter preparation because `tsc` is unavailable; `pnpm format` stops because `oxfmt` is unavailable.
