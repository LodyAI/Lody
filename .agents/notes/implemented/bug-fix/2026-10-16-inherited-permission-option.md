# Carry the inherited permission option across model switches

Status: implemented
Translation: current

[中文](2026-10-16-inherited-permission-option.zh.md)

## Abstract

Agents such as Grok carry their permission policy in a `_permission` config
option (`permission_mode`), not in `modeId`. When a CLI or MCP follow-up switched
the model, or supplied only some config options, the dispatch resolver replaced the
whole inherited config table. That silently dropped "Always Approve" and the turn
ran with Grok's default "Ask Every Time". The resolver now treats `_permission` and
`mode`-category options as model-independent: it keeps them across a model switch
and merges them under a partial explicit table, while effort and Fast stay
model-scoped. Agents that use `modeId` (Claude and Codex) were not affected.

## Decision and evidence

`resolveEffectiveSessionChatDispatchConfig` dropped `previous.configOptionValues`
whenever the requested `modelId` differed, because effort and Fast belong to
one model. Permission does not, but for Grok it lived in that same table.
`mergeTurnDispatchConfig` also replaced the inherited table with any explicit
table, so `--config-option web_search=false` alone reset permission as well.
Session create from an opener shares that merge.

Only options that the capability catalog marks `_permission` or `mode` are
carried. Without a catalog nothing new is carried: that path cannot tell a
permission option from a model-dependent one. An explicit value still overrides
the inherited value, and an explicit `modeId` still removes an inherited
`mode` option (`removeShadowedInheritedSelectors`).

Role discovery had a related defect. It looked for an option whose _id_ was
`_permission` and read `configOptionValues._permission`, so a Role that pinned a
retired Grok `permission_mode` value was reported as available. It now checks
`modeId` against the modes or the `mode` option, and each `_permission` pin
against its own option.

## Not fixed here

The Claude adapter removes `bypassPermissions` from its mode catalog when it
runs as root outside a sandbox, or when settings set
`disableBypassPermissionsMode`. Lody's static Claude catalog still lists Bypass, so
the selection is rejected with a configuration warning and the session stays in
Manual. That needs a separate decision about how the static catalog reflects a
probed restriction.

## Verification

`apps/cli/src/commands/session.test.ts` covers a model switch, a partial override
and an explicit override for a Grok-shaped catalog; the model-switch case fails
without the fix. `apps/cli/src/lib/resource-discovery.test.ts` covers a valid and
a retired `permission_mode` Role pin. No live Grok session was run.
