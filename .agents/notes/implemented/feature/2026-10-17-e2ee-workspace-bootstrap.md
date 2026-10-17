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

## Runtime stability correction

Subsequent review reproduced ordinary-workspace failures during authentication hydration, runtime replacement on unrelated cache changes, and startup rejection when localStorage quota was exhausted. The correction keeps admission strict while separating authentication readiness, optional offline caching and runtime ownership. Initialization waits for the same account, rechecks it at asynchronous boundaries and retries local authentication-unavailable failures even if authentication has already recovered. Replacing the workspace cancels its subscription and ignores late reads; it does not cancel raw I/O or delay the next workspace on a read-only request. Once admitted, auth refresh and unrelated cache events preserve the running Repo and its held sends. Current-workspace evidence changes still force revalidation.

Only an ordinary/legacy mode-cache write may degrade after validation; encrypted pins, corrupt evidence and downgrade conflicts remain blocking. The alternative of catching all admission failures would weaken mode protection; making all cache writes mandatory caused the confirmed quota regression. Behavioral tests cover those distinctions, pending sends, warm-window claims, same-ID resolution, cancellation and cross-account/authentication races. These are component/adapter tests, not installed Electron acceptance.

The Effect migration assessment retains React initialization as owner and the platform observable store/Promise port as its existing dependency boundary. Moving the unfinished runtime dependency chain is not needed for these fixes; the only new subscription is explicitly released on readiness, account mismatch or cancellation. This change claims no native lifecycle migration completion.

## Desktop dependency installation

This integration adds the production dependency path Electron → platform → cloud-api → E2EE core → SQLite. With the same locked dependencies, the actual `@electron/rebuild@4.0.4` walker found no native candidates using baseline `fb4d565` workspace manifests, but selected `better-sqlite3@13.0.3` using `ba794186` manifests. The resulting rebuild failed because `node-abi@4.26.0` could not map Electron `44.7.0`; this is an integration-triggered installation regression, not an unrelated baseline failure.

Postinstall removes the broad `install-app-deps` command, which ignores the existing `npmRebuild: false` packaging setting. SQLite and node-pty keep their Node-API prebuilds; Electron's own binary installer and the separate macOS Sparkle build remain. Packaging still stages each target's binaries and runs its probes. Runtime versions and the [Node-API floor](../bug-fix/2026-09-09-node-api-runtime-floor.md) are unchanged.

The subprocess regression tests fail with the old script and pass with the fix; all 11 native-staging/Sparkle tests passed with npm access for the existing staging fixture. A real macOS arm64 postinstall completed, including Sparkle's native build. The same SQLite prebuild completed an in-memory write/read under Node and Electron `44.7.0`, and node-pty loaded in both. These checks do not establish Windows/Linux execution, foreign-architecture packaging, signed installers or deployment.

## Private Streams ledger refinement

The user confirmed Streams as the private raw-ledger store behind Convex. The shared composition now routes creation/history through actions; describe remains a query and all public DTOs remain unchanged. The private host owns signature/permission verification, conditional append, exact pending intents and cross-service deletion recovery. Client verification and the control-only runtime boundary remain unchanged. The earlier test totals above describe the preceding increment; delivery reports current storage and action-routing verification separately, without inferring deployment or full-stack Beta acceptance.

Current action-routing validation: the full public `pnpm check` passed with the native Git environment, as did formatting and documentation checks. Both standalone and combined cloud-composition suites passed 8/8. The corresponding private host passed its full affected gate; final backend tests passed 750/750 and actual local Convex/SQLite Streams integration passed 19/19 (18 scenarios plus the parent test). Fresh independent adversarial review found no evidenced P0/P1. Earlier local-check failures above remain historical observations, not the current result. No production gateway, installed-keychain or deployment acceptance is implied.

## First-admission availability follow-up

Read-only review of public PR #1625 and private PR #3794 identified a wider availability cost than the initial online-lookup note described: all cloud workspaces without retained mode proof need both live authentication and the backend `describe` operation, even when the developer preference is disabled. The security decision remains unchanged; a cached workspace ID cannot prove plaintext. This follow-up bounds the initial ID/auth/mode waits at 15 seconds, explains the failure, and offers in-place Retry. Authentication or connectivity recovery can retry a failed admission. A timed-out or superseded read cannot admit its late result or rebuild an already healthy runtime. Quota-exhausted storage still prevents the next offline launch from retaining a new ordinary proof.

The same review found a separate private-ledger release blocker: an uncertain external write absent on readback cannot safely surrender ownership or permit account deletion with the current Streams gateway, because a late PUT may recreate a deleted URL. No operator mutation or manual database edit can prove otherwise. Streams needs a durable same-boundary fence/tombstone before Convex can safely reconcile that writer; both PRs remain draft pending that protocol and a delayed-request integration test. The earlier test totals above belong to their stated increments and must not be read as validation of this follow-up.

Follow-up code `bafa14a97` passed the 38/38 focused runtime suite, component typecheck, `pnpm format`, and the full public `pnpm check` in the isolated initialized checkout with native Git. The author checkout's `docs check` retained exactly the same 82 pre-existing missing ACP-submodule links as its starting baseline, with no new errors. The outer sign-in/access gates can still show their existing recovery screen first when no local token exists; the 15-second message belongs to the visible mode gate. CI and installed-client acceptance remain separate.

## Ledger compatibility and recovery follow-up

The owner chose to keep ledger v1 verifiable forever rather than treat preview workspaces as disposable. Comparison with MLS (RFC 9420: fixed version, cipher suite and group ID per group; ReInit creates a linked replacement group; `required_capabilities` gates extensions) and Keyhive (the root public key is the group ID, no version recorded at creation) found nothing the v1 genesis must add. What v1 lacked was a way for an old client to recognize a future record, so tag 9 capability declarations were added before any production ledger exists: Owner or Admin personal devices only (the owner allowed Admin), monotonic, and `upgrade-required` rather than corruption for unsupported codes. Genesis-level changes create a new linked ledger. An independently generated vector freezes the v1 bytes, hashes and state.

Recovery is classified rather than generic: identity conflicts never get a client reset, progress conflicts get a confirmed per-workspace reset, and only unreadable optional caches are deleted. Diagnostics exclude account IDs, keys and record bodies. List locks are display-only. The owner deferred a user-facing delete entry until the Streams tombstone ships, and chose a default-off server creation switch with an allowlist (private backend). Operator rescue functions, the creation switch and the ledger-restore design live in the private host.

Verification for this follow-up: e2ee-core 22 files / 411 tests, including the vector and capability suites; the affected component suites (28 files / 387 tests) and new control-page rendering tests; component typecheck. A mutation check confirmed the in-place retry test fails without the storage re-read. Full `pnpm check`, CI and installed-client acceptance are reported separately.
