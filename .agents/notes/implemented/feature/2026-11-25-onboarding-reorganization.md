# Desktop onboarding reorganization and shared model connection sheet

Status: implemented
Translation: current

[中文](2026-11-25-onboarding-reorganization.zh.md)

## Abstract

Desktop onboarding previously split setup across up to eleven screens (five desktop steps, a five-step Harness Setup wizard, and a Summary screen), probed external CLI installations at daemon startup, and required selecting both an agent and a repository before reaching a composer. The reorganized journey collapses first-run decisions to at most three (`Arrive -> Account -> Model -> Start`), computes `needsModel` upfront from a headless Sorbet `ArrivalProbe`, shares one `ConnectModelSheet` between Onboarding and `Settings -> Lody Agent`, and mounts the real `<ChatComposer>` on `Start` with optional project selection. Rotating subscription refresh tokens from Claude Code and Codex are intentionally not copied into Sorbet because refreshing in both processes invalidates the original CLI session; static API keys import directly, while OAuth accounts hand off to a one-click Sorbet subscription sign-in.

## Decision and evidence

### Upfront headless `ArrivalProbe` and zero unprompted external reads

During `Arrive`, Electron invokes the bundled CLI's internal headless Sorbet helper (`lody __internal sorbet-onboarding probe`) with login-shell environment probing disabled and inherited provider key variables scrubbed. The helper opens `@sorbetai/control` against `<LodyDataDir>/sorbet` (consistent with [Sorbet authentication and local control](2026-11-02-sorbet-acp-authentication.md)) and reads only `credentials.list()`, `authentication.methods()`, and `providers.availableModels()`. Because this helper runs without starting an ACP session or requiring Cloud login, `getDesktopOnboardingSteps({ cloudAccount, needsModel })` resolves the exact step list before `Arrive` finishes even in Cloud mode prior to browser sign-in.

Electron-managed daemon startup (`apps/cli/src/commands/start.ts`) no longer probes `~/.claude*`, `~/.codex*`, `~/.kimi-code*`, or `~/.grok*` unless `--cli-types` is explicitly passed, and `Lody.ensureBuiltinAgentConfigs` registers the bundled `Lody Agent` (`cliType: 'builtin'`, `agentType: 'sorbet'`) with `permission_mode: 'ask'` by default on each machine.

### External credential import and refresh-token rotation constraint

Inspection of `@earendil-works/pi-ai` (used by `@sorbetai/control`) confirmed that both Anthropic Claude OAuth (`platform.claude.com/v1/oauth/token`) and OpenAI ChatGPT/Codex OAuth (`auth.openai.com/oauth/token`) exchange single-use rotating refresh tokens. Copying `~/.claude/.credentials.json` (or macOS Keychain `"Claude Code-credentials"`) or `~/.codex/auth.json` OAuth tokens into Sorbet would sign out the user's existing CLI on the next token refresh.

- Static API keys (`primaryApiKey` / `env.ANTHROPIC_API_KEY` in Claude Code config, `OPENAI_API_KEY` in `~/.codex/auth.json`, and selected keys from `$SHELL -ilc env`) do not rotate and are imported through `control.authentication.login({ type: 'api_key' })` after explicit user confirmation.
- When only rotating OAuth tokens are present, `runSorbetImportSource` returns `status: 'oauth_conflict'` without writing credentials, and `ConnectModelSheet` explains the rotation conflict in one sentence with a direct action to start Sorbet's own OAuth flow.
- On macOS, expanding the Claude Code import row discloses the system Keychain access prompt before any `/usr/bin/security` call occurs.

### Non-secret provenance metadata and retired Settings wizard

Sorbet's `credentials.list()` exposes `{ providerId, type }` and keeps secrets private. To display provenance labels (`Subscription`, `Imported from Claude Code`, `Imported from Codex`, `Imported from env`, `API Key ····last4`) across `OnboardingChipRail` and `Settings -> Lody Agent` without reading Sorbet's private `credentials.json`, Lody stores non-secret source descriptors in `<LodyDataDir>/sorbet-connection-sources.json` (`0o600`) and deletes entries on `logout`.

The standalone five-step `Harness` setup wizard (`packages/components/src/components/harness/setup.tsx`) is removed. `Settings -> Lody Agent` opens directly into its configuration tabs and embeds `ConnectModelSheet` when no model sources are connected on the local machine. Keeping `ConnectModelSheet` under `packages/components/src/components/onboarding/shared/` preserves the deferred settings chunk boundary enforced by `apps/electron/scripts/check-settings-route-chunks.mjs`.

### Lazy non-TCC repository discovery and composer handoff

`StartScreen` defaults to a projectless draft (`project = null`), which `createSessionSubmission` and `SessionManager` already support via default session working directories. Recent repositories are scanned only when the user opens the Project popover, and `discoverRecentLocalRepos` inspects only `~/dev`, `~/code`, `~/Developer`, and `~/projects` (1-2 levels deep), never `~/Documents`, `~/Desktop`, or `~/Downloads`, avoiding unprompted macOS TCC dialogs. Entering the product wraps router navigation in a Same-Document View Transition on `[data-lody-composer-box]` when `prefers-reduced-motion` is off.

## Consequences

First-run setup no longer downloads external runtimes upfront (`use-onboarding-builtin-runtime-prefetch.ts` and `use-builtin-runtime-readiness.ts` are retired); third-party agents remain installable on demand from the `Start` composer's Agent/Model chip or Settings. Persisted pre-reorganization phase values (`ceremony`, `login`, `workspace`, `providers`, `projects`, `firstTask`, `summary`) normalize onto `arrive | account | model | start` so in-progress upgrades resume cleanly.

## Verification

- [`apps/cli/src/lib/sorbet-onboarding-control.test.ts`](../../../../apps/cli/src/lib/sorbet-onboarding-control.test.ts) exercises headless `ArrivalProbe`, non-secret connection provenance storage, static key imports, rotating OAuth conflict detection, and login-shell environment scanning.
- [`apps/electron/src/main/services/local-repo-discovery.test.mjs`](../../../../apps/electron/src/main/services/local-repo-discovery.test.mjs) verifies allowed developer directory scanning, TCC directory exclusion, and static prompt-hint detection.
- [`packages/components/tests/onboarding-flow.test.tsx`](../../../../packages/components/tests/onboarding-flow.test.tsx), [`packages/components/tests/desktop-onboarding-completion.test.ts`](../../../../packages/components/tests/desktop-onboarding-completion.test.ts), and [`packages/components/tests/onboarding-analytics.test.tsx`](../../../../packages/components/tests/onboarding-analytics.test.tsx) cover the 4-step matrix, `ConnectModelSheet`, `StartScreen` composer interactions, and completion/analytics invariants. Live external OAuth provider round-trips and real macOS Keychain dialogs are not exercised in automated tests.
