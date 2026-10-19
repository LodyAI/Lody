# Invalidate DeepSeek Harness npx closures by runtime fingerprint

Status: implemented
Translation: current

[中文](2026-10-19-dsh-npx-runtime-cache.zh.md)

## Abstract

Lody's isolated npx cache treated a DeepSeek Harness closure as healthy whenever the top-level
`@deepseek-ai/dsh` version and bin were present, so an Electron upgrade could keep loading a
nested `node-addon-require-builtin` that rejects the new Electron/V8 fingerprint. DeepSeek
Harness now records the active runtime in each closure, invalidates a closure only when that
marker no longer matches, and forces one online metadata refresh before reinstalling. A narrow
native-addon failure signature recovers legacy closures that predate the marker. The trade-off is
that only DeepSeek Harness opts in, and switching between Lody builds with different Electron
runtimes reinstalls its closure when the fingerprint flips.

## Problem

`inspectNpxInstallState()` validated the root manifest, the requested top-level package version,
and the bin target, but not nested native dependencies. Issue #1704 reported a Lody 0.106.0
upgrade that reused a cached `@deepseek-ai/dsh@0.2.0-rc.2` closure containing
`node-addon-require-builtin@0.1.7`. That addon advertises Electron 43.0.0, 44.0.0, and
45.0.0-alpha.6, but not the active 44.7.0 fingerprint, so host preparation failed every time.
Deleting `_npx/<hash>` alone did not help: `--prefer-offline` resolved 0.1.7 again from the
retained `_cacache` packument. The failure text was not in `BROKEN_INSTALL_SIGNATURES`, so the
startup policy neither purged nor retried.

DeepSeek Harness `0.2.1-rc.2` now depends on `node-addon-require-builtin@^0.1.9`, which removes
the exact bad resolution for a fresh closure. The validation gap remains for a top-level-healthy
closure with an incompatible nested addon, and a future Electron upgrade can reproduce the class.

## Decision

- `npx-cache.ts` exposes a runtime fingerprint (`electron`, `node`, `v8`, `modules`, `platform`,
  `arch`) and reads or writes `_npx/<hash>/.lody-runtime.json`.
- `inspectNpxInstallState()` accepts an optional fingerprint. A present marker that differs is a
  `runtime-fingerprint-mismatch` problem; a missing marker stays healthy so the change does not
  invalidate every existing closure on upgrade.
- `runNpxStartupWithRecovery()` purges only the mismatched closure inside `allowedRoots`, forces
  one `--prefer-online` attempt, and records the marker after a successful start using a
  temporary file plus rename. A marker-write failure is logged and never fails startup.
- A narrow native-addon signature set (`unsupported Electron runtime fingerprint`,
  `node-addon-require-builtin unsupported`, Node ABI mismatch) performs the same purge and one
  online retry for legacy closures. A single recovery flag bounds the retry, so a repeated
  failure surfaces the original error.
- Only DeepSeek Harness passes the fingerprint. Claude, Codex, and registry npx agents keep their
  existing `--prefer-offline` behavior.

Deleting `_cacache` was rejected: every npx closure shares it, and removing it would turn one
runtime-specific failure into a full reinstall. Pinning `node-addon-require-builtin` was rejected
as the sole fix because it addresses one package and breaks the same-version closure contract.

## Limits

- A legacy incompatible closure still fails once before the signature recovery runs; the marker
  exists only after a successful start under the new code.
- A persistently failing marker write is not remembered, so every start retries it. It does not
  block startup.
- Switching between Lody builds with different Electron runtimes flips the fingerprint and
  reinstalls the Harness closure each time.
- The signature set depends on upstream error text. Native failures with different wording still
  surface unchanged.
- Verification is unit-level with injected IO. The original Electron 44.7.0 / DSH 0.2.0-rc.2
  failure was not replayed end-to-end; the addon support matrix was read from the published
  0.1.7 and 0.1.9 binaries.

## Verification

Passed: `pnpm --filter lody test src/agent/npx-cache.test.ts` (67 tests) and
`pnpm --filter lody typecheck`. Tests cover marker match/mismatch, legacy closures, the forced
online refresh, marker-write failure, bounded native-addon recovery, and refusal to purge the
default user npm cache.
