# CLI WASM assets

Status: implemented
Type: architecture
Translation: current

[中文](2026-11-02-cli-wasm-assets.zh.md)

## Abstract

The CLI's previous WASM loader embedded Loro and Flock binaries as base64
JavaScript constants. Long-lived Node processes retained large source strings
and constants after initialization. CLI builds now emit the unchanged binaries
as package assets and load them through module-relative file URLs. The module
bindings remain native ESM; consumers await instantiation through top-level await.

## Decision

The previous plugin constructs base64 URLs directly in its SSR loader, so Vite's
asset inline-size setting does not change that path.
The build inspects WebAssembly imports and exports to generate Node ESM bindings.
Rollup assigns hashed asset names and resolves their paths relative to each
emitted chunk. The runtime reads each binary with `node:fs/promises` before
instantiating it with the original imports. Arbitrary export names retain their
names through quoted ESM exports.

The npm `dist/` inclusion and desktop's recursive CLI staging carry the assets.
Electron's existing `resources/**` unpacking puts them beside the embedded CLI;
the packaging hook compares the staged and packaged bytes on every target.
The existing `zstd.wasm` loader continues to use its entry-relative file.

The official Node Loro entry also avoided the embedded strings in an experiment,
but its WASM binary differs from the bundler entry. Emitting the current bytes
preserves the existing binary rather than switching builds of the engine.

This addresses a different retained allocation from the earlier
[message-schema sharing](2026-10-30-desktop-schema-initialization.md) and
[internal MCP entry](2026-10-30-internal-mcp-command-loading.md) changes.

## Resident memory

One OSS desktop pair on macOS arm64 uses Electron 44.9.3 / Node 24.22.0,
base `e705a48356ebff10ffc8644253553a5d63df45ff` and this change. Both profiles
complete onboarding and restart with one visible empty window. Values are the
median OS footprints at two and three idle minutes, before diagnostic GC.

| Footprint, MiB | Base | WASM assets | Reduction |
| --- | ---: | ---: | ---: |
| Daemon | 171.14 | 149.96 | 21.18 |
| MCP host | 111.99 | 93.25 | 18.74 |
| Desktop process group | 670.02 | 627.84 | 42.17 |

The process group uses OS group accounting. RSS totals include shared mappings
and varied between samples; these footprint values do not express an RSS reduction.
Separately initialized MCP hosts retain about 6.85 MiB less JS heap and 12.91 MiB
less script source after tool requests. Their complete tool definitions and
validation/authentication responses match under both supported MCP protocols.

## Verification

[CLI build integration](../../../../apps/cli/tests/vite-config.test.ts) executes
the built module in a fresh Node process after moving the output and deleting
the source. It checks binary identity, imported functions, memory, quoted exports
and missing-asset initialization. [Desktop staging tests](../../../../apps/electron/scripts/cli-native-deps.test.mjs)
exercise complete, missing and changed packaged assets.
