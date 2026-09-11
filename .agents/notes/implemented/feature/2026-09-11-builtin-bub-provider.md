# Add Bub as a builtin ACP provider

Status: implemented
Translation: pending

## Abstract

Bub was not reachable from Lody's Agent Config picker even though its
`bub-acp-server` plugin exposes the workspace over ACP. Bub is now a builtin
provider that launches the user-installed `bub acp serve` command. Lody does not
download, version, or sign in to Bub; the command is spawned from the same
augmented login-shell PATH as other local ACP agents. A failed creation probe
surfaces an install hint with a link to Bub's ACP server tutorial, so a missing
plugin reads as an install problem instead of a dead provider. The capability
cache key is static because Lody cannot observe the user's Bub version; users
re-probe after an upgrade.

## Decision and ownership

`BUILTIN_AGENTS` in `packages/shared/src/ai.ts` owns the provider list, so Bub
joins it rather than the ACP registry. The registry's `local` distribution is
the other plausible home: it already models user-installed CLIs such as Cursor
and Goose. It was not chosen because the request was to place Bub in the
Built-in group, and a builtin entry keeps the provider first-class in the Agent
Config picker. The trade-off is visible: builtin rows carry no `Registry` badge
even though Lody owns the integration, not the runtime.

- `resolveBuiltinACPProcessLaunch` in `apps/cli/src/agent/setting.ts` owns the
  launch spec: `bub acp serve`, with caller extra args appended.
- `getAcpCapabilitySourceVersion` returns the static
  `builtin-bub:local` key. A runtime version probe was rejected for now: the
  request explicitly deferred install-state handling, and a probe would add a
  spawn on every capability lookup.
- `STATIC_BUILTIN_ACP_CAPABILITIES.bub` is deliberately empty. Bub publishes its
  own modes, models, and config options over ACP, so the dialog must run a real
  probe instead of offering invented options. `BUILTIN_DEFAULT_MODE_IDS.bub` is
  only a harmless pre-probe fallback; selectors ignore it when the adapter does
  not offer `default`.
- `BUILTIN_ACP_TITLE_OWNERSHIP.bub` is `none`: Bub pushes no authoritative
  session title, so Lody keeps its isolated title agent.
- The install prompt is rendered by `AgentConfigDialog` from
  `getBuiltinAgentInstallDocsUrl`, and opens
  `https://bub.build/docs/tutorials/acp-server/` through `openExternalUrl`.
  Creation requires a live probe for Bub, which is what makes a missing command
  fail here rather than on the first turn.
- Bub's mark is traced from the logo in `bubbuild/bub` into
  `packages/components/src/assets/bub.svg` with `currentColor`, and rendered by
  `AgentIcon`. The upstream repository ships only raster wordmarks, so the icon
  is a faithful trace rather than an official vector.

The hand-maintained builtin literal in `local-session-control.ts` / `.cjs` now
also lists `bub`. The same literal was missing `grok`, so accepting every
`BUILTIN_AGENTS` entry required adding both; previously a builtin Grok session
config was rejected by the local control validator.

## Verification

- `packages/shared`: typecheck plus the full suite (1125 tests), including the
  new `ai-bub` contract tests and the updated title/validator coverage.
- `apps/cli`: typecheck plus the `agent-setting`, `provider-setup-manager`, and
  `acp-capabilities` suites, including the new `bub acp serve` launch and
  extra-arg cases.
- `@lody/components`: typecheck plus the `agent-config-dialog`,
  `onboarding-flow`, `acp-selector-options`, `provider-row-reauthentication`,
  and `onboarding-summary-agent` suites. The dialog test drives the probe
  failure and asserts the install hint and guide button.
- `pnpm lint:fast`, `pnpm format:check`, `pnpm lint:i18n`, docs `status` /
  `check`, and the code-collab, platform, and public-boundary guards.
- Not verified: a real end-to-end ACP session against a machine with Bub
  installed. The install prompt is exercised through the dialog test rather
  than a live runtime.

## Integration

- [PR #591](https://github.com/LodyAI/Lody/pull/591)
