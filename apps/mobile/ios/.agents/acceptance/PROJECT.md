# Lody iOS acceptance

## 1. Project summary

UIKit iOS app in apps/ios; UI, state and coordinators live in LodyKit.

## 2. Environment

Generate with `pnpm prebuild` and `pnpm --filter @lody-ios/ios pods`.
Use `pnpm verify:build` for a signed simulator build. `pnpm start` opens Xcode;
there is no JavaScript development server. Runtime asset changes require
`pnpm --filter @lody-ios/ios native:assets` before rebuilding.

## 3. Auth

UI regression baselines use `pnpm verify:ui --app <Debug.app>` and automatically
lease a reusable `Lody * Verify` Simulator. For a build plus multiple checks, use
`pnpm verify:simulator --name '<current verify>' -- <command>` and target
`$LODY_VERIFY_UDID`; nested verify commands reuse that lease. Never call
`simctl create` directly for local verification. Explicit `--udid` is reserved
for a caller-owned device such as CI, which also owns its cleanup.
For a local full run, `pnpm verify:ui --parallel --app <Lody.app>` leases separate
Simulators for the native batches. Do not wrap parallel mode in a single-device
lease. The runner launches with `--ui-verify`, disables account restoration and
network access, and uses production controllers with deterministic services.
Reuse one `--output` path per verify (retries replace it); never suffix `-1`/`-2`
unless comparing two builds. Build with `pnpm verify:build`, which reuses the
workspace Xcode DerivedData and prints the App path for `--app`; keep one build
cache per checkout, and never copy the checkout into the temp directory to build
(`pnpm verify:clean` reports and reclaims those leftovers). No account, cloud
credentials or connected machine is needed. See
`apps/ios/verification/ui/README.md` for cases, evidence and CI setup.

Official Lody Device Flow and simulator Keychain only. Inspect the simulator UI for existing login; never copy desktop credentials. No seeded account is provided. Unauthenticated checks must be reported separately from authenticated flows.

## 4. Surfaces

Use AXe with explicit simulator UDID and simctl screenshots. `pnpm verify:build`
builds project apps/ios/Lody.xcodeproj, scheme Lody, Debug, with normal
signing and one shared DerivedData; the app bundle identifier is ai.lody.mobile.
Run pnpm check, pnpm test and pnpm bundle as supporting gates.

UI evidence for a visual or interaction requirement alignment comes from a finished
`pnpm verify:ui` run exported by `apps/ios/verification/ui/acceptance-round.py`
(claims file + `lh acceptance run ingest`). Export and ingest by hand, only for
that alignment; regression runs stay programmatic gates and are never ingested.

## 5. Project probes & quick navigation

`xcrun simctl list devices booted`; `axe describe-ui --udid <id>`. Home has an adaptive inbox/session/inspector split; Settings opens from the inbox. Development-only Debug lives under Settings.

## 6. Known constraints

Cloud data requires app-authorized login and a connected computer. Do not send real turns merely to verify layout. Preserve all pre-existing working-tree edits. Simulator cannot prove physical haptics.
