# Refresh and validate built-in agents

Status: implemented
Translation: current

English | [中文](2026-09-23-builtin-agent-refresh.zh.md)

## Abstract

This refresh upgrades Claude, Codex, Grok, Kimi, and Pi and verifies each built-in provider as far as available credentials and installed runtimes allow. It publishes 22 immutable runtime artifacts and updates manifests only after integrity readback. Integration tests exposed a Kimi startup/deletion race and independent builds exposed absolute temporary symlinks in Pi packaging; both are fixed. Codex was rechecked at the owner's request and advanced again to 0.156.0. Authenticated Kimi/Dimcode prompts and installed Bub execution remain unverified, and this work does not merge main or release the Lody application.

## Versions and verification

| Provider | Previous → selected                           | Evidence                                                                                                                                       |
| -------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | SDK 0.3.274 → 0.3.280; Code 2.1.274 → 2.1.280 | 1,369 passed, 28 skipped; build/static checks; authenticated ACP prompt                                                                        |
| Codex    | 0.154.0 → 0.156.0                             | 810 passed, 27 skipped; build/typecheck; actual binary version and authenticated ACP prompt ending with `end_turn`                             |
| Grok     | 1.0.34 → 1.0.40                               | 64 passed; build; official native runtime completed authenticated ACP prompt                                                                   |
| Kimi     | upstream 2.0.0 → 2.0.2                        | 181 ACP and 56 session-index tests; build/typecheck; packaged ACP initialization                                                               |
| Pi       | 0.85.1 → 0.87.0                               | 52 passed; build/typecheck/format; native deterministic questions, resume, subagent lifecycle/cancel, Stop/recovery and extension opt-in smoke |
| DSH      | 0.1.5-rc.2 unchanged                          | 34 adapter tests and five real runtime settings/question tests                                                                                 |
| Dimcode  | 0.5.10 unchanged                              | Real ACP initialization; session creation requires provider credentials                                                                        |
| Bub      | User-installed, not managed                   | Not installed here; no real execution claimed                                                                                                  |

## Compatibility fixes

- Kimi's existing ACP lifecycle test reproduced a deleted session returning during initial index projection. Removal now waits for preparation and projection before eviction. The full ACP suite changed from 180 passing/one failing to 181 passing; the owning index suites also pass. The owner confirmed the patch changeset wording before commit. The released upstream 2.0.2 commit `9d07f634` is integrated in source commit `d4caf044fe0c3c12aa8496f9fa442643d521e479`.
- Codex 0.156.0 adds `workspaceRouting: null` to the unauthenticated account response. The owning snapshot is updated while retaining the authentication-failure assertion. An older project-recovery error assertion now includes the existing project-path text; production behavior is unchanged.
- Two independent Pi builds differed only in 20 `.bin` symlinks rewritten to absolute temporary build paths. Packaging now preserves relative dependency links, excludes install-time shims, and rejects absolute, escaping, or dangling links. Five real-filesystem regression tests cover relocated links and failure paths. Two independent fixed builds produced SHA-256 `0942748a1ca3b6d6eb083ef4ed6717f07838b2479f8dfb7e913f47efe58ce4f2` and 37,201,691 bytes. The final manifest references this fixed object, not the earlier uploaded object; immutable objects are not overwritten.

## Publication and host checks

The owner explicitly authorized task-branch pushes and production publication. Follow the [artifact-first workflow](2026-09-17-managed-runtime-refresh.md): verify official sources or clean commits, publish versioned objects, read back hashes and sizes, then switch manifests. Claude has eight targets, Codex and Grok six each, and Kimi/Pi one portable package each. Public download checks passed; Grok, Kimi and Pi were downloaded in full, and Claude/Codex public HEAD sizes match their R2-verified archives. Kimi's clean package is `2.0.2-lody.d4caf044fe0c`, SHA-256 `9815b2b309f842e7880385555c46bc80f77a802190c9e733398d3143272f686a`.

Pi's exact source `e6debc2f6aaca6f0fd3409f6dd36468a8fba8a8f` passed [Linux and Windows x64/arm64 CI](https://github.com/LodyAI/acp-extension-pi/actions/runs/35764930929), including installed-package smoke on Node 22 and 24. Both CI native binaries are included in the portable archive. Its [draft PR](https://github.com/LodyAI/acp-extension-pi/pull/3) remains unmerged.

The complete root `pnpm check` and `pnpm format` passed after installing the locked Electron binary. This includes 2,863 CLI tests (three skipped), 3,895 component tests and 168 Electron tests. The packaging fix passed all 33 script tests and lint. Normal host tests use the final manifests, not temporary candidate aliases. Frozen installation, documentation and public-boundary checks passed. Exact release-age exceptions remain limited to selected runtime packages; unrelated transitive lockfile upgrades were removed. No captured conversations are committed.

## Limits

Kimi and Dimcode need credentials for authenticated prompt verification. Bub is user-installed and was absent. These limits are not counted as successful end-to-end tests. Platform artifact integrity checks are not execution tests for every operating system; only Pi additionally has the explicit Windows CI evidence above. No main-branch merge or application release is implied by artifact publication.
