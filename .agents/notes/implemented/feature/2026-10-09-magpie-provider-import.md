# Confirmed local Magpie provider import

Status: implemented
Translation: current
PR: [#1357](https://github.com/LodyAI/Lody/pull/1357)

[中文](2026-10-09-magpie-provider-import.zh.md)

## Abstract

Lody could target a custom gateway, but lacked an application import action and
runtime model-catalog preparation for Magpie. A versioned local-only link now
stages a global checkbox dialog; confirmation creates selected builtin Providers
through the existing Machine Flock paths. The daemon prepares Claude, Codex, Pi,
DSH, Kimi Code, Grok and Bub using Magpie's live catalog without editing native
user profiles. This
implements the Lody receiving side; Magpie's own application-list adapter remains
separate, and full live-provider conversation acceptance remains unverified.

## Decision and responsibilities

The [Spec](../../../../specs/magpie-provider-import.md) owns the public payload,
local-machine restriction, naming and lifecycle. The chosen Cindy-style handoff
lets Lody own confirmation, persistence and runtime preparation. Direct edits to
Lody's storage, as Magpie does for T3 Code's JSON settings, would bypass those
owners and were not adopted.

The import accepts only Magpie's nonsecret `magpie-lody` loopback attribution token.
It is not a generic API-key importer: vendor credentials stay with the local
gateway. Provider env contains only agent-supported mappings; `AgentConfigMeta.magpieGatewayUrl`
is separate host-owned launch metadata. Storage, resume, forks, probes and capability
identity preserve it without exporting an internal process environment switch. The
unreleased draft marker was removed without a legacy fallback. Launch preparation
generates configuration under `getLodyDataDir()`. Codex uses a separate
home and the existing adapter startup-overlay contract; its model catalog must be
applied before native `model/list`, not only as a later session override. Pi uses
an isolated profile instead of changing the user's `models.json`. The cost is that
this profile does not implicitly inherit native global Pi settings/extensions.

A gateway-specific capability-source suffix prevents a native/default catalog
from masquerading as the imported Provider's catalog. Refresh and future launches
read the gateway again, while running sessions keep their existing snapshot.
Managed runtimes reuse background setup; the non-managed DSH route writes its
configuration directly and discovers the endpoint on startup. Import completion
therefore means durable configuration, not successful upstream inference.

Kimi Code and Grok load generated TOML from Lody-owned homes, with quoted model keys
and values. Grok constrains its picker and auxiliary title/summary models to the
Magpie catalog and disables campaign overrides. Bub uses native OpenAI environment
configuration without editing user files; Bub and its ACP plugin must be installed
by the user. Its current model menu derives from the default and fallback list,
so import sets only the first default and clears fallbacks instead of enabling
implicit model switching merely to expose the catalog.

## DSH Provider isolation

The overwrite reproduction showed that each launch rewrote the generated profile
that Magpie also edited. The implemented fix threads Provider identity through
session creation/preparation, capability probes, authentication, history replay and
title generation. Each Provider now has a stable home and editable patch under the
Lody data root; generated defaults live in a versioned local bundle. A final
route-neutral host layer preserves ACP, history paths and disabled telemetry.
User patch creation uses exclusive creation, so repeated/concurrent launches and
adapter upgrades do not replace edits. Provider details derive the YAML path from
the machine's published data root, gated by `dshProviderIsolation: 1`.

Existing session artifacts and query paths are retained. Old settings/profiles are
left untouched and are not automatically selected or cloned into every Provider;
users migrate desired customizations to the displayed path. Standalone Magpie's
default DSH scan does not discover these isolated homes. The Lody import environment
continues to supply the Magpie endpoint and public token.

Validation includes concurrent launches, two Providers, adapter relocation, preserved
YAML/settings/history, and the installed pinned DSH 0.1.5-rc.2 native composition:
base bundle → generated host bundle → user patch → host guard. A synthetic edited
model survived while telemetry remained disabled and the ACP entry upgraded.

## Ablation-backed cleanup

Pinned DSH 0.1.5-rc.2 `prepareProfile` recreates `cordis.yml` before boot.
Removing Lody's duplicate write preserves the composed ACP entry, edited user
model and telemetry guard, so only DSH now writes that empty include root.
Provider IDs remain on async DSH launches; unused copies on native login/status
and the synchronous spawn fallback were removed after startup/authentication tests.
Bub now reuses `mergeLoopbackNoProxy` instead of its own comma-list merger.
The unconditional call stays: `withLoopbackNoProxy` alone does nothing when proxy
environment variables are absent, while Python can still inherit macOS system proxies.

Negative controls rejected two tempting deletions: removing the final guard lets
a user patch re-enable telemetry; removing the generated host bundle loses the ACP
entry. These layers have distinct responsibilities and are retained. Existing
runtime suites cover the cleanup; no compatibility or input-validation boundary
was removed merely because a happy-path test passed.

## Evidence and validation

- Magpie source inspected at `62b1c995ffaebb223ad040b4c54ebabab0078c7a`:
  [Cindy adapter](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/agent/cindy.go),
  [T3 Code adapter](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/agent/t3code.go),
  [integration contract](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/docs/integrating.md).
- Deterministic tests cover payload boundaries, checked targets, local-only writes,
  partial failure/retry, runtime catalog generation, invalid/oversized responses,
  global dialog selection and asynchronous submission, and desktop routing.
- An isolated synthetic-catalog smoke check used the installed Codex 0.159.2
  `app-server` and the pinned Pi runtime: native `model/list` and `--list-models`
  both accepted and exposed the generated synthetic model, without a paid model call.
- `pnpm check` passed (full tests, typecheck, lint, i18n and boundary guards),
  as did `pnpm format` and `pnpm docs check`. The test command used native Git
  (`env -u GIT_EXEC_PATH PATH="/usr/bin:$PATH" pnpm check`) because the authoring
  session Git shim otherwise contaminates the synthetic recursive-clone fixture.
- The installed manifest-pinned `acp-extension-pi` artifact
  `0.2.0-lody.693d6964a676` was also exercised through ACP, using
  `prepareMagpieRuntime` against a loopback synthetic gateway: `session/new`
  exposed both generated models, `session/set_config_option` selected the second,
  and `session/prompt` reached `/v1/chat/completions` with the expected public token.
  Native `read` returned a synthetic file into the next request and the ACP turn
  finished with `end_turn`. This validates the adapter path, not commercial inference.
- Additional ACP smoke used pinned Kimi Code `2.0.2-lody.743c6641b898`, Grok
  `1.0.40` and the current Grok ACP adapter: generated catalog discovery, model
  switching and Chat Completions requests passed against a synthetic loopback
  gateway. Grok initially used its native default for title requests; auxiliary
  model pins and a catalog allowlist corrected this and passed the repeated smoke.
- [Bub](https://github.com/bubbuild/bub) and its
  [ACP plugin](https://github.com/bubbuild/bub-contrib/tree/main/packages/bub-acp-server)
  passed ACP creation, default-model completion and `end_turn` in a temporary Python
  environment without changing the user's Bub installation. Its Python client inherits
  macOS system proxies; launch appends loopback to existing `NO_PROXY` exclusions,
  and the repeated smoke reached the local gateway directly. Bub is unpinned; other
  user-installed versions still require the existing setup probe.
- Remaining acceptance: real Magpie conversations/tool calls across all supported
  agents, packaged cold/warm launch across OSes, and a separate upstream Magpie
  adapter. Tests do not claim these have run.
