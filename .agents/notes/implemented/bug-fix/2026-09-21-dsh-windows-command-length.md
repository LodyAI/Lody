# Bypass Windows shell limits for DSH startup

Status: implemented
Translation: current

[中文](2026-09-21-dsh-windows-command-length.zh.md)

## Abstract

Lody's pinned DSH dependency closure expands to more than 12,000 command-line
characters, exceeding Windows cmd.exe's 8191-character limit. The npx shim exits
before ACP initialization, surfacing as `ACP connection closed` and
`turn_pre_prompt_failed`. Session and probe/title spawns now execute npm's JavaScript
npx entry with Lody's Node, preserving dependency pins and existing npx recovery.
The process regression runs with synthetic packages; native Windows packaging
validation remains outstanding.

## Decision

Keep the logical `npx` command and exact package argv through cache isolation,
cold-start classification, and retries. At each actual Windows DSH spawn, use
the final environment's PATH/PATHEXT and working directory to select npx, then
run the adjacent `node_modules/npm/bin/npx-cli.js` using `process.execPath`.
Inherited `ELECTRON_RUN_AS_NODE` remains intact. Native `.exe`/`.com` shims are
already shell-free; script shims missing the npm entry fail explicitly instead
of selecting a different installation. Other providers and POSIX launches retain
their existing behavior.

Both `Session.createAgent` and `spawnAcpProcess` apply the same conversion, so
ordinary conversations, capability probes, and titles use the fix. npm still
installs the complete exact-version closure and invokes the existing short Node
forwarder; DSH still calls `runCli()` under Lody's runtime. No credentials or
user logs are written into generated files or fixtures.

This complements the [bundled Node fix](2026-09-16-dsh-bundled-node-runtime.md),
which addresses `import.meta.main` compatibility rather than command length.
Moving dependency installation to a new manifest/cache protocol would require
replacing existing recovery behavior; the spawn-only conversion avoids that
larger change. Nonstandard shell-only npx wrappers must expose a standard npm
installation or use a native launcher.

## Verification

The owning runtime suite executes the full generated argument list through a
synthetic npm JavaScript entry, the existing Node forwarder, and a synthetic
DSH `runCli()` entry. It checks exact argument preservation, cache environment,
selected runtime, and profile arguments, including an installation path with
spaces. Failure cases verify npm's nonzero exit and diagnostic propagation,
missing-entry rejection, and missing-npx rejection without network access.
The same suite retains the POSIX bootstrap regression. Native Windows packaged
execution must still be checked before treating this as release verification.

`pnpm check`, `pnpm format`, and `pnpm run docs check` passed on macOS.

## Integration

- [Lody PR #871](https://github.com/LodyAI/Lody/pull/871)
