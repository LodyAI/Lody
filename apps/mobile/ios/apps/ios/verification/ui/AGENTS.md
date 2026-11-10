# Native UI verification

- UI Verify runs only in English (`en`, `en_US`), retaining light/dark coverage. Do not run a separate Chinese locale pass.
- UI Verify establishes the English software keyboard and offline environment once per runner batch; cases reuse that baseline. Enter Debug fixtures through `UI.open_case` deep links, never by scrolling the Debug menu. Batch text input; use individual software keys only when the key interaction is itself under test. Record entry/check timings and prefer observable readiness over fixed sleeps.
- On native UIKit pages use `axe drag`, not `swipe`; swipe doesn't drive UIKit pan gestures (switch thumbs, edge back).

- UI baselines must run without login, user credentials, cloud access, or a connected machine. Add independently resettable Debug scenes using production controllers and `LodyShell.presentNative`; inject deterministic data/service outcomes at their boundary.
- UI changes must add/update a behavior check in `apps/ios/verification/ui` or reuse the existing native checks. Shared controls must be exercised in each affected host.
- Local checks omit `--udid` to lease a `Lody * Verify` Simulator. Build with `pnpm verify:build` (one shared Xcode DerivedData per checkout; never pass a per-task `-derivedDataPath` or copy the checkout into the temp directory, and reclaim such leftovers with `pnpm verify:clean`). Wrap build + multi-check flows with `pnpm verify:simulator --name '<current verify>' -- <command>` and use `$LODY_VERIFY_UDID`; never call `simctl create` directly. Explicit `--udid` is for caller-owned devices such as CI. See [the runner guide](README.md).
- Capture screenshots for visual states and video for temporal behavior. Missing scenes/timeouts fail verification; screenshots alone do not establish visual correctness.
