# Move the desktop runtime to Electron 43

Status: implemented
Translation: current

[中文](2026-09-30-electron-43-runtime.zh.md)

## Abstract

The desktop ran Electron 39, which is out of support and force-disables Chromium's
macOS WebContents occlusion tracking, so a covered Lody window never reached
background throttling through that path. The runtime moves to Electron 43.7.6 with
electron-vite 6.0.0-beta.5, the first electron-vite release whose build-target table
covers Electron 42-44. Electron 43 keeps macOS 12 and the synchronous clipboard
API, so this step needs no user-visible migration. It does need two policy
exceptions that a maintainer must accept: a prerelease build tool, and 19 packages
admitted before pnpm's seven-day release quarantine. The power benefit of the
restored occlusion tracking is not measured yet.

## Pressure

A power investigation on 2026-09-29 found `--disable-features=MacWebContentsOcclusion`
on every Electron 39 process. Electron force-disabled that feature until
[electron/electron#50579](https://github.com/electron/electron/pull/50579) fixed its
multi-WebContents visibility bug in 40.9.0, 41.2.0 and 42.0.0. Electron 39 has also
left the supported window (42, 43 and 44 are supported as of 2026-09-30).

The earlier Electron 44 stack ([#635](https://github.com/LodyAI/Lody/pull/635),
[#636](https://github.com/LodyAI/Lody/pull/636)) was closed under the no-workaround
upgrade policy. electron-vite 5.0.0 has no build target past Electron 39 and silently
falls back to Node 16 / Chrome 108 for an unknown major, and Electron 42+ no longer
downloads its binary during install. The compatible API preparation landed separately
([Electron API preparation](../bug-fix/2026-09-13-electron-api-preparation.md)).

## Decision

- Pin `electron@43.7.6` rather than the newest 44.5.1. Electron 44 drops macOS 12,
  removes the synchronous clipboard API that the image export still uses, and has an
  open startup crash on macOS 27 when system-power registration fails
  ([electron/electron#54490](https://github.com/electron/electron/issues/54490)).
  43.7.6 is the first 43 release with the WASM code-cache fix
  ([electron/electron#54234](https://github.com/electron/electron/pull/54234)); Lody
  loads Loro and Flock WASM, and Sparkle updates in place between patch releases.
  It also carries the ELECTRON_RUN_AS_NODE exit-crash fix (43.4.1), the
  transparent-occluder fix (43.2.0) and the idle-wakeup reduction (43.4.1).
  Electron 43 reaches end of life on 2027-01-05; the 44 move then only adds the
  clipboard contract and the macOS 13 floor.
- Use `electron-vite@6.0.0-beta.5`. It is the only release with Electron 42-44
  targets; no configuration change was needed. Vite stays on 7, so the renderer is
  still bundled by Rollup.
- `scripts/postinstall.mjs` runs Electron's idempotent `install.js` before
  `install-app-deps`, because dev, preview and the E2E harness launch the binary
  through `electron/path.txt`.
- Admit the Electron, electron-vite, rolldown and magic-string versions and all 15
  `@rolldown/binding-*@1.2.11` packages in `minimumReleaseAgeExclude`. A quarantined
  optional binding is dropped from the lockfile without an error; rolldown 1.2.11
  then resolved a hoisted 1.1.5 binding and failed while bundling
  `electron.vite.config.ts` (`sourcemapPathTransform ... returned object`). A clean
  install of rolldown 1.2.11 with its own binding works.

## Alternatives

- Electron 44.5.1: rejected for now for the macOS 12 drop, the clipboard migration
  that must land atomically ([desktop native interactions](../../../../specs/desktop-native-interactions.md)),
  and the open macOS 27 crash report.
- Keep electron-vite 5 and set explicit build targets plus a manual binary install:
  this is the workaround the #635 review declined.
- Wait for electron-vite 6.0.0 stable: the safest option if the prerelease is not
  acceptable. Six betas shipped from 2026-04 to 2026-09-29, including two breaking
  fixes within three days.

## Verification

On macOS 27 arm64, against the pre-upgrade build of the same base:

- `pnpm --dir apps/electron build` (typecheck included) passes; main output grows by
  5 bytes, preload is identical, renderer has the same 598 files and +0.25% bytes.
- Electron unit tests: 199/199. CLI suite on Node 24.21 (the embedded Node of 43.7.6):
  3253 passed, 4 skipped.
- `pnpm run package --dir` on 43.7.6 passes the embedded CLI boot plus SQLite and
  node-pty probes. All native addons in the app are Node-API, so none needs a rebuild.
- `pnpm e2e:check`, `pnpm e2e:smoke` (6/6) and `pnpm e2e:full` (24/24 scenarios,
  249 steps).
- A child process of Electron 43.7.6 and 44.5.1 no longer carries
  `MacWebContentsOcclusion` in `--disable-features`; 39.5.1 does.
- Deleting the Electron binary and running `pnpm install` restores it.

## Limits

- Windows and Linux were not built or launched locally. The dropped-binding failure
  is platform specific, so CI must cover them.
- Whether occlusion tracking lowers Lody's power use is unmeasured. A covered-window
  A/B was inconclusive because the probe windows were not reliably on screen. It
  would not address the dominant cost measured in the same investigation, where
  infinite animations keep a visible window producing frames at display refresh rate.
- electron-vite 6 is a prerelease and its later betas may change behavior again.
