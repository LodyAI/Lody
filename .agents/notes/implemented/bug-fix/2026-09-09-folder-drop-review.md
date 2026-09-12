# Preserve every dropped directory mention

Status: implemented
Translation: current

[中文](2026-09-09-folder-drop-review.zh.md)

## Abstract

A single drop of multiple folders could overwrite earlier insertions because each
insertion read the same controlled textarea value before React rendered again.
The composer now submits one batch that produces the complete text and committed
ranges together. Path normalization and insertion also preserve POSIX and Windows
drive roots. The separate review claim that the preload lacks a path bridge does
not apply to the locked toolkit version; no additional preload exposure is needed.

## Evidence and decision

[PR #312](https://github.com/LodyAI/Lody/pull/312) has three review findings:

- Multiple folders: reproduced with two synchronous inserts after an existing
  mention. Only the second new folder survived in the text. Both landing and
  in-session drop handlers now call `insertPathMentions` once; the shared primitive
  accepts a batch and applies its splices against successive text/range results.
  It updates the controlled text and final caret once, preserving existing ranges.
  Per-folder flushes or scheduled rerenders were unnecessary.
- Filesystem roots: reproduced `/` being rejected and `C:/` becoming the
  drive-relative `C:`. The shared normalizer preserves roots, and insertion reuses
  it rather than stripping slashes again. Directory range payloads do not append
  another slash when the normalized root already ends in one.
- Missing bridge: the lockfile resolves `@electron-toolkit/preload` to `3.0.2`.
  Its shipped `electronAPI.webUtils.getPathForFile` wraps Electron's native method,
  and `apps/electron/src/preload/index.ts` exposes that object in both context
  isolation branches. Adding a second bridge would duplicate the existing API.

The product intent remains absolute-path directory mentions, with regular files
still attached and unavailable browser/mobile paths ignored. No cloud or IPC
capability changes are introduced.

## Verification

Regression tests reproduce the original multi-folder and root failures. Composer
coverage checks all inserted text/ranges, an existing range, paths with spaces,
focus and final caret, and empty batches. Normalization covers POSIX and Windows
roots. Manual native drag-and-drop has not been exercised.

Validation: 21 related Vitest files / 202 tests passed; components typecheck,
type-aware lint on changed sources/tests, formatting, and docs checks passed.
The root `pnpm check` stopped at CLI typecheck because the Claude, Codex, and
Grok submodule checkouts are missing; its later stages were not reached.
