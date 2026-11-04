# Trim Electron runtime packaging inputs

Status: implemented
Translation: current

[中文](2026-10-10-electron-runtime-payload.zh.md)

## Abstract

The embedded CLI staged all five Loro distributions although its workers execute
only the Node entry. Staging now keeps `nodejs/`, package metadata and the license,
including the adjacent WASM. Electron packaging also excludes the Sparkle build
archive while retaining its native addon and separately copied framework. The
installed Loro 1.16.3 package shrinks from 20,033,458 to 3,753,709 bytes in staging;
this is not a measurement of a complete installer.

## Decision and boundaries

`scripts/cli-native-deps.mjs` owns the CLI payload. Its clean staging pass selects
the Node distribution explicitly instead of copying browser, bundler, web and
base64 variants. The package metadata remains unchanged so Node conditional
exports and `require.resolve` continue to work. The renderer builds its browser
WASM separately; this selection must never apply to renderer dependencies.

`electron-builder.yml` omits `native/sparkle-chain.tar.xz`. The archive is a build
input; `native/build/Release/*.node` and `Sparkle.framework` remain runtime inputs.
Deleting all application dependencies would break dynamic runtime loaders, so
this change deliberately limits pruning to these known packaging inputs.

## Verification

The owning staging suite loads the actual installed Loro package from an isolated
temporary node_modules directory. It checks CommonJS root and Node subpath
resolution, then exchanges a snapshot with an ESM worker that imports Loro and
edits a document. This exercises the staged WASM as well as JavaScript resolution.
Existing Roost staging tests cover foreign binary selection and host execution.
The four staging tests also pass under Electron with `ELECTRON_RUN_AS_NODE=1`.
The actual electron-builder file matcher excludes the 1,588,780-byte Sparkle
archive and retains the native addon. Documentation checks pass.
Full signed installers and foreign-platform execution remain separate release
validation; staged-byte savings do not predict compressed download savings.
