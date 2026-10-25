# Subscription quota with ordinary environment settings

Status: implemented
Translation: current

[中文](2026-10-25-subscription-quota-environment.zh.md)

## Abstract

Builtin Codex, Claude and Grok providers lost their subscription quota display and
on-demand refresh whenever any environment variable was configured, even a tool
credential unrelated to the model account. A shared pure policy now permits ordinary
environment settings while retaining exclusions for authentication, configuration
and provider-routing overrides. The renderer and daemon use the same independent
module. Account isolation and refresh lifecycle behavior are unchanged; no live
subscription account was used for verification.

## Policy and evidence

`packages/shared/src/subscription-quota.ts` owns account eligibility. Capability
declaration remains a separate requirement: version 1 to display, `query: true` to
refresh. Readers still select the exact Provider id. This replaces the blanket env
exclusion in the [quota refresh decision](../architecture/2026-10-13-provider-quota-refresh.md)
and preserves [Provider isolation](2026-09-30-provider-rate-limit-isolation.md).

- Claude adapter `c06641c` calls `getUsage()`, which reads native OAuth credentials
  from Keychain or the home credential file independently of the SDK's configured
  authentication. Reuse the shared Claude authentication/routing keys and exclude
  alternate OAuth/config inputs from the locked SDK. Tool and model-tuning variables
  alone do not establish another account.
- Codex adapter `df464ab` delegates to native `account/rateLimits/read`. Its entry
  accepts `CODEX_CONFIG`, `MODEL_PROVIDER` and `DEFAULT_AUTH_REQUEST`; API credentials,
  home and identity overrides also remain excluded. Managed ChatGPT profiles may
  carry ordinary tool variables; existing managed-profile validation still rejects
  identity overrides. API-key profiles remain ineligible.
- Grok adapter `2fc653b` delegates to native `x.ai/billing`. Official package
  `@xai-official/grok@1.0.46` documents `XAI_API_KEY`; Lody's Magpie launcher uses
  `GROK_HOME`, `GROK_CONFIG` and model-selection variables for custom routes.
  These remain excluded, as do explicitly marked brands and Magpie gateways.

Rules inspect configured key names, never log values, and match case-insensitively
for Windows. An empty account override remains excluded because clearing inherited
credentials can change account choice. Common home/config discovery and code-loading
overrides remain excluded. This is a configuration policy, not a runtime account
attestation: inherited process settings and native configuration files are not
inspected. Custom/registry adapters retain their existing capability-owned semantics;
other builtin agents retain their previous env policy pending their own source audit.

## Scope and verification

The pure helper needs no Effect service or migration. Existing query coalescing,
configuration/revision fences, process cleanup and cached-data preservation remain
owned by the existing refresh workflow. No adapter versions, wire/storage formats,
credentials or user data change.

Tests cover ordinary env settings, account/route overrides, empty and Windows-cased
keys, managed-profile validation, rendered Provider-specific percentages and daemon
query publication. Existing failure/push/deletion cases and a config-change case
verify preservation of cached quota. Shared targeted suites pass 41 tests, component
suites pass 33, and the complete execution-service suite passes 315. Shared,
Components and CLI typechecks and the public-boundary check pass. The documentation
check still reports six pre-existing missing links in uninitialized Kimi/Pi
submodules; changed documents have no errors. Real account/platform acceptance
remains unverified.

Full `pnpm check` passes workspace typechecks, lint and Effect lint, then stops
in unchanged CLI Git/worktree suites (5 failures, 4621 passed, 4 skipped):
macOS temporary-path spelling, frozen submodule identity, a timeout and host Git
credential context. Components pass all 6069 tests. Later root checks were not
reached. `pnpm format` passes. These failures were not repaired in this quota change.
