# Match the desktop runtime to DSH's native loader

Status: implemented
Translation: current

[中文](2026-10-10-dsh-electron-runtime.zh.md)

PR: https://github.com/LodyAI/Lody/pull/1367

## Abstract

DeepSeek Harness 0.2.0-rc.2 exits before ACP initialization under Electron 43.7.6:
node-addon-require-builtin 0.1.9 rejects its Node/V8 fingerprint. Pinning Electron
44.7.0 restores capability discovery in an isolated macOS arm64 probe using the
existing packaged adapter and runtime closure. The upgrade also migrates image
clipboard writes to Electron 44's asynchronous API and raises the macOS floor to
13. Full installer and other-platform validation remain outstanding.

## Decision and evidence

Keep DSH on the host's `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, preserving
the [bundled-runtime decision](2026-09-16-dsh-bundled-node-runtime.md). Change the
desktop pin and its exact release-age exception to 44.7.0, without exempting later
Electron versions. The existing electron-vite 6.0.0-beta.5 target table already
maps Electron 44 to Node 24.18 and Chromium 152.

The same synthetic profile, packaged ACP adapter, and installed Harness closure
fail under the existing 43.7.6 Helper and pass under official 44.7.0 in Node mode.
Both embed Node 24.21.0; V8 changes from 15.0.245.31-electron.0 to
15.2.124.28-electron.0. The new runtime returns initialize capabilities and a new
session's model, reasoning effort, permissions and all four preset choices.
No model request or real credentials are needed for this comparison.

Electron 44 removes `clipboard.writeImage`. Decode and validate the image first,
encode PNG, construct a MIME-typed `ClipboardItem`, and await `clipboard.write`
before returning success. Rejections remain recoverable IPC results. This completes
the deferred image migration from the [API preparation](2026-09-13-electron-api-preparation.md).

This supersedes the runtime selection in the [Electron 43 decision](../process/2026-09-30-electron-43-runtime.md),
including its macOS 12 support. The [native interaction Spec](../../../../specs/desktop-native-interactions.md)
remains draft. The [Harness upgrade](../feature/2026-10-09-dsh-harness-upgrade.md)
had left the packaged desktop path unverified.

## Validation and limits

- Desktop main/renderer typechecks and all 214 desktop tests pass using installed
  dependency links with Electron 44.7.0. Frozen lockfile consistency, changed-code
  formatting and public-boundary checks pass. Documentation validation has six
  pre-existing missing-file links into the uninitialized Kimi/Pi submodules.
- Before submission, root `pnpm format` passes using the installed formatter.
  Root `pnpm check` stops while building the Claude ACP adapter because this
  nested worktree lacks its dependencies (including `@tsconfig/node22`). This
  is not a passing full-repository check.
- macOS arm64: real ACP initialize/session-new comparison, CLI `--help`, SQLite
  insert/read, PTY child execution, Loro export/import and Roost Worker persistence
  probes pass under 44.7.0 using the existing packaged native dependencies.
  ACP initialization/session-new also passes using the 44.7.0 Electron Helper binary.
- The changed image service was bundled and run in an isolated Electron 44 main
  process. A controlled clipboard writer verifies pending completion, rejected
  writes, invalid bytes and the PNG ClipboardItem payload, without changing the
  user's system clipboard. Native clipboard round-trip remains unverified.
- These probes reuse an existing packaged CLI; they are not a newly built installer,
  signing/notarization check, complete desktop E2E run, or Windows/Linux validation.
  The running user application is unchanged.
