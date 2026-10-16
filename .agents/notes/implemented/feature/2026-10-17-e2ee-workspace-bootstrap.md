# Developer creation and ledger preview for E2EE workspaces

Status: implemented
Translation: current

[中文](2026-10-17-e2ee-workspace-bootstrap.zh.md)

## Abstract

The merged core lacked a product entry point for a distinguishable encrypted workspace and its initial device. This change connects a developer preference, protected desktop device preparation, a dedicated cloud creation operation and a readable complete ledger page. Keys are retained locally before the fixed request submits genesis; a known encrypted workspace cannot enter the old plaintext runtime. This delivery exposes control operations only, not encrypted chat, attachments, recovery enrollment, all-platform custody or production activation.

## Decision and responsibilities

The user requested workspace mode, developer access, a distinct cloud identity, first-device keys and ledger tracking as the first slice. The [implementation guide](../../../docs/e2ee-workspace-bootstrap.md) owns entry points and data flow. Ordinary workspaces cannot convert; product workspace ID and genesis are bound one-to-one. Device private keys never enter cloud requests or renderer memory.

Desktop main owns preparation using the existing custody adapter, real signatures and a SQLite original-request journal. Closing or cancelling waits for native settlement; uncertain outcomes remain retained rather than creating replacement identity. The cloud adapter verifies account ownership and the receipt. The page retains pending work per account and request, then fixes the genesis hash after success. History uses full and incremental core verification rather than trusting a server JSON permission projection.

A remote-only mode lookup would break offline startup and fail to stop a pinned encrypted identity from being downgraded. Retained immutable account/workspace mode evidence therefore preserves offline access while local encrypted constraints take precedence. Old caches without registered mode need an initial online verification, an explicit limit of preventing downgrade. Independent windows cannot share one overwritable pending slot.

This slice does not migrate plaintext, offer creation on platforms without custody, or connect unprotected data channels. The [existing core boundaries](../architecture/2026-10-15-e2ee-current-decisions.md) and draft protocols remain applicable; this note does not approve protocols or all-platform Beta.

## Verification and limits

Coverage includes real crypto/SQLite restart, uncertain creation, account changes, tampered/paginated ledger history, and real local control-service creation, concurrent retry and cleanup. Independent review found multiwindow intent loss, mode downgrade and plaintext offline regressions; this change repairs them with behavioral coverage. Final commands and outcomes accompany delivery. Synthetic protection providers do not prove user OS keychain usability, signed packaging or deployed behavior; no user keychain or production data was inspected.

Targeted verification: 77 frontend, 7 cloud-composition, 26 desktop custody/bootstrap and 2 IPC checks passed; the private backend passed 726 tests and 18 real local Convex checks. A fresh independent review reran 36 tests across three relevant suites against matching source and found no remaining evidenced P0/P1. Browser inspection covered synthetic ledger/creation layouts on desktop and mobile. Full repository checks and deployment outcomes are reported separately, not inferred from these counts.

Repository validation: typecheck, type-aware lint, Effect lint, formatting and documentation checks passed. The full `pnpm check` did not finish green: unchanged CLI tests encounter the injected Git environment and the macOS process probe deadline. Git tests pass 24/24 with a native Git environment; the Inbox suite passed 60/60 once, but repeated isolated runs still hit the existing probe deadline. These are retained as validation limits, not bypassed or described as full-check success. Final desktop custody/bootstrap tests passed 26/26 after the mechanical lint fixes.

## Desktop dependency installation

This integration adds the production dependency path Electron → platform → cloud-api → E2EE core → SQLite. With the same locked dependencies, the actual `@electron/rebuild@4.0.4` walker found no native candidates using baseline `fb4d565` workspace manifests, but selected `better-sqlite3@13.0.3` using `ba794186` manifests. The resulting rebuild failed because `node-abi@4.26.0` could not map Electron `44.7.0`; this is an integration-triggered installation regression, not an unrelated baseline failure.

Postinstall removes the broad `install-app-deps` command, which ignores the existing `npmRebuild: false` packaging setting. SQLite and node-pty keep their Node-API prebuilds; Electron's own binary installer and the separate macOS Sparkle build remain. Packaging still stages each target's binaries and runs its probes. Runtime versions and the [Node-API floor](../bug-fix/2026-09-09-node-api-runtime-floor.md) are unchanged.

The subprocess regression tests fail with the old script and pass with the fix; all 11 native-staging/Sparkle tests passed with npm access for the existing staging fixture. A real macOS arm64 postinstall completed, including Sparkle's native build. The same SQLite prebuild completed an in-memory write/read under Node and Electron `44.7.0`, and node-pty loaded in both. These checks do not establish Windows/Linux execution, foreign-architecture packaging, signed installers or deployment.
