# Upgrade electron-sparkle-updater to 0.5.1

Status: implemented
Date: 2026-09-19
Translation: current
[中文](2026-09-19-electron-sparkle-updater-0-5-1.zh.md)

## Abstract

The desktop's Sparkle bridge stayed pinned at 0.3.0 while upstream shipped delta-chain
updates, per-delta signature verification, an `installUpdateOnQuit` bridge API, and an
`init()` fix that clears feed URLs persisted by the deprecated `setFeedURL:` API. The pin
moves to 0.5.1 with a `minimumReleaseAgeExclude` entry because the release is younger than
the seven-day quarantine. No app code changes were required beyond dropping a now-dead
`publicEdKey` placeholder argument; packaging paths, the addon rebuild flow, and the event
contract are unchanged.

## Evidence

- API diff 0.3.0 → 0.5.1: `loadSparkleBridge`, `init`, `checkForUpdates`,
  `installUpdateNow`, `setAutomaticChecks`, and `setEventHandler` keep their signatures.
  `SparkleInitOptions.publicEdKey` became optional and advisory-only — the bridge warns
  when a supplied key has no `SUPublicEDKey` in Info.plist to back it; packaged builds
  always inject the real key at afterPack, so `AppUpdaterService` now passes the
  `SPARKLE_ED_PUBLIC_KEY` environment value only when set.
- Package layout changed: the npm tarball carries `native/sparkle-chain.tar.xz`, a
  prebuilt universal Sparkle 2.9.4 framework with the delta-chain patch applied.
  `fetch-sparkle.sh` extracts it into `native/vendor/` when the patch hash matches, so
  `electron-builder.yml` (`native/vendor/Sparkle.framework`, `native/build/Release/*.node`)
  and `resolveSparkleAddonPath` still resolve. Release CI no longer needs a Sparkle source
  download or Xcode build for the framework; node-gyp still compiles the bridge.
- The 0.5.1 `clearFeedURLFromUserDefaults` fix is defensive for this app: 0.3.0 already
  only called `setFeedURL:` when Info.plist lacked `SUFeedURL`, which packaged builds
  always set.
- `download-progress` events gained `phase: 'apply'` and `fallback` fields for delta
  chains; `sparkleEventToStatePatch` still maps them onto `downloading`, which is correct
  but indistinguishable in the renderer.
- Delta updates need server-side feed generation (`generate_appcast` + BinaryDelta
  history). The client is delta-capable after this bump; the release pipeline lives
  outside this repository.

## Trade-offs

- The `minimumReleaseAgeExclude` entry is a deliberate one-version quarantine bypass
  approved by the requester; the seven-day delay still applies to everything else.
- `installUpdateOnQuit()` is unused; `quitAndInstall` keeps its immediate-restart
  semantics.

## Verification

- `node --test` on the three Sparkle suites (`app-updater-sparkle-policy`,
  `app-updater-sparkle-events`, `sparkle-packaging`) — 24 tests pass.
- `tsgo` typecheck on the Electron node project passes.
- `pnpm exec electron-sparkle-updater rebuild --arch arm64` produced
  `native/build/Release/sparkle_bridge.node` linked against the vendored universal
  framework on Electron 39.5.1.
- A packaged end-to-end update (`verify:sparkle-update`) was not re-run; it exercises the
  same rebuild + plist + appcast path already covered above.
- `pnpm run docs check` fails on a pre-existing broken link in `specs/usage-delivery*.md`
  caused by a local submodule checkout; unrelated to this change.
