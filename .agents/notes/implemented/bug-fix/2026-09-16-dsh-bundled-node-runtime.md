# Run DSH with Lody's bundled Node

Status: implemented
Translation: current

[中文](2026-09-16-dsh-bundled-node-runtime.zh.md)

## Abstract

DeepSeek Harness 0.1.5-rc.2 silently exited when Lody launched it through a user-installed
Node release where `import.meta.main` was unavailable, and capability refresh surfaced only
`ACP connection closed`. Lody now keeps npx responsible for materializing and repairing the
pinned package closure, but starts the DSH entry with the packaged Lody Node runtime and calls
its exported CLI explicitly. Package installation still requires an available npx command;
DSH execution no longer inherits the user's Node feature set.

## Cause and decision

The published DSH entry ended with an `import.meta.main` guard. The affected machine launched
it with Node 24.1.0, where that property evaluated to `undefined`, so the command exited zero
without starting ACP. The packaged Lody Helper uses Node 22.22.0 and exposes the property, but
the previous `npx ... dsh` launch caused npm to select the user's Node for the executable.

The host now asks npx's Node to run a minimal CommonJS forwarder, which safely spawns
`process.execPath` even when the Lody Helper path contains spaces. A small ESM bootstrap in that
child finds `@deepseek-ai/dsh` in the npx-provided PATH, verifies the exact pinned version,
restores DSH's expected `process.argv`, imports its entry, and explicitly awaits `runCli()`. In
the packaged desktop `process.execPath` is Lody Helper and the existing
`ELECTRON_RUN_AS_NODE=1` inheritance makes it act as Node. Keeping npx as the outer launcher
preserves the Lody-owned npm cache inspection, cold-start timeout, stale-metadata retry, and
broken-install recovery paths.

Downgrading DSH would couple the fix to an older feature set without establishing a stable
Node compatibility contract. Patching the downloaded package would also bypass package
integrity and cache recovery. An upstream direct-entry fix remains useful, but the host-owned
runtime selection is still required because desktop behavior must not vary with the user's
Node installation.

## Verification

The runtime regression test builds a synthetic npx package closure, executes the generated
forwarder and bootstrap in separate processes, and verifies that the selected runtime calls an
imported `runCli()` with the exact profile arguments even though the imported module is not the
main module. The complete CLI suite passed: 266 files and 2,849 tests, with three skipped.

A real macOS probe used the installed Lody Helper (Node 22.22.0), the cached pinned DSH
0.1.5-rc.2 closure, and the generated Lody profile. It returned a valid ACP `initialize`
response advertising `acp-extension-dsh` 0.2.0. Native Windows and Linux packaged probes
remain to be run; the bootstrap uses Node's platform path delimiter and package paths rather
than shell launcher parsing.

## Integration

- [Lody PR #747](https://github.com/LodyAI/Lody/pull/747)
