# Apply ACP model-dependent options after model selection

Status: implemented
Translation: current

[中文](2026-10-13-acp-model-effort-order.zh.md)

## Abstract

An Agent Role can request Max effort yet start a Worker at Low when its model is applied after effort. Lody applied top-level model selections first, but applied model selections inside the options dictionary in enumeration order. The shared session configuration applier now resolves both representations and applies mode, model, then dependent options. Synthetic stateful regressions reproduce the ordering failure; the reported live Worker and its installed OpenCode version were not available for verification.

## Cause and decision

Registry/custom agents use generic configuration selectors in
`packages/components/src/components/shared/acp-selector-options.ts`.
The Role form therefore stores their model and effort together in
`runConfig.configOptionValues`; MCP Role creation preserves that run config.
The old `applyAcpSessionRunConfig` iterated its entries directly. With effort
before model, a successful model switch could erase the earlier effort without
rejecting either request. This is order-dependent behavior, not a timing race.
Top-level `modelId` took a different, correctly ordered path.

The exposure is shared by registry/custom ACP agents, not specific to OpenCode.
It becomes observable when model/mode changes reset dependent controls or when
an option is supported only by the target model. Built-in Role selectors use
top-level model fields and avoid this particular dictionary-order path; a caller
that supplies their model through config options can still reach it. This fix
covers both representations for every provider. It does not establish that every
provider resets effort, nor does it cover provider-internal configuration bugs.

OpenCode's [configuration source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/config-option.ts)
builds effort choices from the selected model's variants. `selectVariant` keeps a
valid variant, otherwise selects `default` if advertised, otherwise the first
variant. Consequently the fallback is not universally Low: it depends on the
model's catalog. The [ACP reference](https://dev.opencode.ai/v2/docs/cli/acp/#config-options)
also documents effort as model-dependent. These upstream references are moving
branches/documentation, not evidence of the affected installation's version.

Resolve mode/model by the advertised category ids (with the existing fallback
ids), retain top-level precedence, apply mode then model, and skip their dictionary
entries during the remaining option pass. This also handles a mode switch that
changes the model. Keep rejection diagnostics, model warnings, confirmed runtime
state and abort fences. Mode selections from either representation now share the
existing top-level mode rejection policy. Do not sort the stored Role or teach
only the editor an ordering rule: stored/transported dictionary order is not an
execution contract. Both speculative preparation and foreground/recovery callers
use this applier. This complements the
[startup-model decision](2026-10-09-codex-resume-model.md): live application remains
necessary for agents that ignore startup metadata.

The Promise-based AgentClient still owns the underlying requests. An Effect
migration would cross unfinished Lody dependencies and does not help this ordering
fix, so it remains outside this change. Cancellation is checked after each request
and before subsequent mutations; this patch does not claim to cancel raw ACP I/O.

## Verification and limits

The owning suite checks reordered option dictionaries, mixed top-level/option
selections, target-model-only effort, precedence, rejection and cancellation.
Tests assert resulting agent state and the confirmed runtime patch, not just call
counts. Before the fix, the initial three ordering cases failed; after the fix,
all 42 tests in the configuration, AgentClient preparation and runtime-config suites pass.
Validation reused the existing checkout's installed dependencies without changing
the lockfile. Full CLI type checking is blocked by uninitialized ACP submodules
and mismatched shared dependency declarations in that installation. Documentation
checking reports existing links into uninitialized submodules. No live inference
request, deployment, or change to a saved Role was performed. Before committing,
root `pnpm check` and `pnpm format` were attempted but stopped because this
worktree lacks installed `tsgo`/`oxfmt` executables. Targeted Oxfmt checking passes
using the existing installation.
