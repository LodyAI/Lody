# ACP-owned session titles

Status: draft
Translation: current

[中文](acp-session-titles.zh.md)

Except for builtin Codex below, when a Provider generates its own session title, Lody must not launch another
ACP process for the same job. A Provider opts in through Core's initialize
capability `agentCapabilities._meta.lody.sessionTitle: { version: 1 }`.

The main Session initializes before the title ownership decision. Live capability
support applies to builtin, registry and custom Providers, including runtime
overrides, even without a prior capability probe. The existing managed
Claude/Grok identity fallback remains for older runtimes; overrides disable
that fallback. Other runtimes retain isolated generation.

The Provider pushes standard `session_info_update` notifications with `title` and
`_meta.lody.titleSource`. `generated` requires the advertised capability;
`explicit` remains accepted for compatibility. `fallback`, `unset`, malformed
source tags, empty titles and notifications for another ACP Session are rejected.
Untagged titles remain supported only for legacy Claude/Grok. Lody sanitizes
accepted titles and updates only draft/generated titles, preserving user renames.
Provider failure leaves the draft title; no timeout starts a duplicate generator.

Capability probes and normal Session initialization persist the boolean support
in the per-Provider cache. Settings hide isolated-generation options when matching
capability data says the Provider owns titles. Custom command and runtime-override
source matching continue to apply. Cache version changes affect refresh freshness,
not readability of understood fields; live initialization decides execution.

## Builtin Codex

Lody owns builtin Codex titles, including when old capability caches or runtimes
advertise title ownership. The Provider configuration page exposes the existing
title model, reasoning, and permission controls. A non-empty saved title
configuration takes precedence; otherwise the independent title session uses
`gpt-5.6-luna`, `low`, and `agent-full-access`. These choices never change the main
conversation's configuration. Unavailable required options fail title generation
rather than silently selecting a different model or permission mode; the existing
prompt-derived fallback remains.

The bundled Codex adapter does not generate titles or advertise `sessionTitle`.
It retains native explicit name updates and tagged prompt previews. Only the
independent Lody session performs the title request, using the Provider's existing
authentication. Other Providers retain their negotiated title ownership.

## Evidence

- [Core](../packages/acp-extension-core/README.md#automatic-session-titles)
- [CLI implementation](../apps/cli/src/agent/README.md#session-titles)
