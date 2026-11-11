# General rules (iOS)

Read before any change under `apps/mobile/ios`. These rules bind every caller of the area, not only files in its directory.

- This is an independent iOS-only UIKit client. pnpm builds the bundled cloud protocol assets; XcodeGen generates app, extension and verification targets; Swift Package Manager builds LodyKit and its native dependencies.

- First-party UI and state live in the Swift package `packages/LodyKit/Sources/LodyKit`; the application entry point is `App`, and extensions are in `Extensions`. Use Swift/UIKit or SwiftUI; do not add bridge packages. SwiftPM discovers LodyKit sources automatically. Run `pnpm prebuild` after changing app/extension source membership or shared extension references in `project.yml`; never edit the generated Xcode project by hand.

- Do not add Android implementations, fallback stubs, or Android build scripts.

- `apps/ios/Lody.xcodeproj`, `.generated` are generated. Persist app configuration in `apps/ios/App`, app/extension target definitions in `apps/ios/project.yml`, and package dependencies/resources in `packages/LodyKit/Package.swift`. Run `pnpm prebuild`.

- Keep normal Xcode signing enabled, including simulator validation. Do not use `CODE_SIGNING_ALLOWED=NO`.

- Cloud integration targets official Lody Cloud. Use browser-safe public protocol imports in `packages/cloud-runtime`; do not import Node-dependent `@lody/shared` or `@lody/loro-streams-rpc` root entries, absolute paths from another checkout, or private backend packages.

- Credentials belong in Keychain. Never copy desktop credentials, tokens, transcripts, or private service configuration into this repository.

- `LodyApplication` owns lifecycle and application coordinators. `AuthSession`, `CatalogSession` and `OutboxSession` own native state; feature controllers observe their projections. Keep protocol code in `packages/cloud-runtime` and generated wire types in `packages/lody-core` (`pnpm contract`).

- Preserve user edits. Before destructive revert/restore/rollback, inspect the working tree and obtain explicit confirmation.

- Verify with `pnpm check`, `pnpm bundle`, and an iOS simulator build when changing native code. Prefer behavioral checks over implementation snapshots.

- Do not nest ternary expressions. One `cond ? a : b` is fine; a `?` inside either branch is not. Map a closed set with a dictionary, and use `if` / `switch` for ordered or overlapping conditions. Optional chaining and `??` are not ternaries.

- `pnpm test` checks cloud protocol and verification tooling. Use Node 22 LTS (22.13+) for TypeScript stripping and module mocks. `pnpm verify:native` checks native behavior; `swift test --package-path packages/lody-core` checks routing and protocol policy.

- Build-time backends are resolved by the shared `../backend-config.mjs`; see [backend configuration](../backend-configuration.md). Keep Swift and bundled runtime configuration identical; nonproduction storage must never reuse production credentials or caches. All configurations require public HTTPS origins; never relax TLS validation.

- Generate native runtime assets before prebuild/build. Preserve dependency licenses beside generated resources. Native watchdog behavior has a deterministic Swift check in `verification/kit/watchdog`.
