# Add Bub as a builtin ACP provider

Status: implemented
Translation: pending

## Abstract

Bub was not reachable from Lody's Agent Config picker even though its
`bub-acp-server` plugin exposes the workspace over ACP. Bub is now a builtin
provider that launches the user-installed `bub acp` command. Lody does not
download, version, sign in to, or auto-register Bub; the command is spawned from
the same augmented login-shell PATH as other local ACP agents. Explicit creation
first writes a durable setup row, and only a successful live probe publishes the
Agent Config. A failed probe stays retryable and links to Bub's ACP server tutorial,
so a missing plugin never becomes a dead provider. The capability
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
  launch spec: `bub acp`, with caller extra args appended.
- `getAcpCapabilitySourceVersion` returns the static
  `builtin-bub:acp` key. A runtime version probe was rejected for now: the
  request explicitly deferred install-state handling, and a probe would add a
  spawn on every capability lookup.
- Bub has no entry in `STATIC_BUILTIN_ACP_CAPABILITIES` or
  `BUILTIN_DEFAULT_MODE_IDS`. It publishes modes, models, and config options over
  ACP, so the dialog waits for the live probe instead of offering invented
  defaults.
- `BUILTIN_ACP_TITLE_OWNERSHIP.bub` is `none`: Bub pushes no authoritative
  session title, so Lody keeps its isolated title agent.
- Bub creation uses the durable `providerSetup` queue. Unlike managed builtins it
  skips binary preparation, probes the user-installed command directly, and
  publishes the config only on success. Failed setup rows retain an install-guide
  action; machines predating the setup protocol cannot create Bub from the dialog.
- Startup auto-registration remains limited to `MANAGED_BUILTIN_RUNTIMES`, so Bub
  appears as an available choice but is never created until the user explicitly
  chooses it. CLI `agent-config create --agent-type bub` classifies that explicit
  config as `builtin`, matching the desktop path.
- Bub's mark is traced from the logo in `bubbuild/bub` into
  `packages/components/src/assets/bub.svg` with `currentColor`, and rendered by
  `AgentIcon`. The upstream repository ships only raster wordmarks, so the icon
  is a faithful trace rather than an official vector.

The hand-maintained builtin literal in `local-session-control.ts` / `.cjs` also
lists `bub`, with a parity test covering both implementations.

An ablation pass removed behavior that was not necessary to make Bub usable:
the empty static-capability object and speculative default mode, a duplicate
dialog/onboarding install action already owned by the failed setup row, a
single-consumer shared install-guide abstraction, repeated shared assertions,
and an unrelated Grok validator correction. The remaining branches each protect
an observable contract: explicit selection, deferred verification, success-only
publication, launch, session validation, or recovery guidance.

## Verification

- `packages/shared`: typecheck plus the full suite (1125 tests), including the
  new `ai-bub` contract tests and the updated title/validator coverage.
- `apps/cli`: typecheck plus the `agent-setting`, `provider-setup-manager`, and
  `acp-capabilities` suites, including the new `bub acp` launch and
  extra-arg cases.
- `@lody/components`: typecheck plus the `agent-config-dialog`,
  `onboarding-flow`, `acp-selector-options`, `provider-row-reauthentication`,
  and `onboarding-summary-agent` suites. Follow-up coverage verifies that Bub
  creation authors a setup row instead of publishing a config and that legacy
  daemons cannot fall back to eager publication.
- `provider-setup-manager` coverage verifies that Bub skips runtime download,
  probes from the durable setup row, and publishes only after success. CLI
  command coverage verifies that explicit Bub creation uses `cliType: builtin`.
- `pnpm lint:fast`, `pnpm format:check`, `pnpm lint:i18n`, docs `status` /
  `check`, and the code-collab, platform, and public-boundary guards.
- Not verified: a real end-to-end ACP session against a machine with Bub
  installed. The setup and install-guide paths are exercised through component
  and queue tests rather than a live runtime.

## Integration

- [PR #591](https://github.com/LodyAI/Lody/pull/591)
