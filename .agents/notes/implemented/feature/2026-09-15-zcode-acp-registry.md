# Add ZCode ACP registry entry

Status: implemented
Translation: current

[中文](2026-09-15-zcode-acp-registry.zh.md)

PR: https://github.com/LodyAI/Lody/pull/729

## Abstract

Lody did not offer ZCode even though the ZCode desktop app ships a headless app-server. A new local registry entry launches the community bridge `acp-extension-zcode@0.38.1` through `npx`; the bridge auto-discovers `zcode` from `ZCODE_BIN`, `PATH`, or the desktop app bundle. The entry is registry data only, so the existing runtime launcher and capability cache are unchanged. Publication of the pinned npm version is a hard prerequisite, and live execution against an installed ZCode app remains unverified here.

## Decision and evidence

- `zcode-acp` is added to `LOCAL_REGISTRY_AGENTS` in `scripts/generate-acp-registry.mjs`, with its fallback name and description in the same file.
- The entry uses the existing `npx` distribution rather than a builtin or managed runtime. This matches the request for a Lody-maintained registry type and keeps runtime ownership in the separate adapter.
- The version is pinned to `0.38.1`, the first release containing the ACP-compliant `authenticate` and `session/fork` fixes.
- `zcode-acp.svg` is bundled as a local-only registry asset so the picker renders offline.
- Regenerating the snapshot also refreshed unrelated upstream entries (`minimax-code` and routine version updates); they are generated output, not a separate provider decision.

## Verification

- `node --test scripts/generate-acp-registry.test.mjs` — 3 tests passed.
- Prior branch validation: `@lody/shared` and `@lody/components` typecheck, `@lody/shared` 107 files / 1225 tests, and `check-public-boundary` passed.
- Not verified: publishing `acp-extension-zcode@0.38.1` and starting a real session on a machine with the ZCode desktop app installed.

## Integration

- [acp-extension-zcode PR #1](https://github.com/Leeeon233/acp-extension-zcode/pull/1)
