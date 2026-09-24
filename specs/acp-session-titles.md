# ACP-owned session titles

Status: draft
Translation: current

[中文](acp-session-titles.zh.md)

When a Provider generates its own session title, Lody must not launch another
ACP process for the same job. A Provider opts in through Core's initialize
capability `agentCapabilities._meta.lody.sessionTitle: { version: 1 }`.

The main Session initializes before the title ownership decision. Live capability
support applies to builtin, registry and custom Providers, including runtime
overrides, even without a prior capability probe. The existing managed
Claude/Codex/Grok identity fallback remains for older runtimes; overrides disable
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

## Evidence

- [Core](../packages/acp-extension-core/README.md#automatic-session-titles)
- [CLI implementation](../apps/cli/src/agent/README.md#session-titles)
