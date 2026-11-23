# Imported ACP session identity

Status: draft
Translation: current

[中文](imported-acp-session-identity.zh.md)

## Scenario

A user with multiple configurations of the same ACP agent imports a conversation,
continues it, or forks it before sending a new message. Those actions must retain
the selected Provider and source conversation rather than guess a default account.

## Responsibilities

Project history selection names a concrete machine-local Provider. The daemon
validates its machine, id and agent family before launching list or history reads.
A missing or mismatched selection fails without a default-account retry. Catalogs
are scoped by Provider id; identical native ids in different bound Providers do
not identify the same imported conversation. Existing transcript ids and hashes
remain stable. An unbound legacy import is bound only after the selected Provider
lists its source; an existing binding is never replaced.

Clients send this selection only after `localProjectHistoryProvider` version 1 is
advertised. Older daemons retain their existing family-level UI; legacy requests
still use the unique same-type Provider when available, otherwise the historical
default-launch behavior. There is no workspace-wide migration of old conversations.

Imported source identity and Lody-owned runtime identity are distinct. Continuation
and ordinary/worktree fork share one resolver, preferring an owned runtime and
otherwise using the imported source. A source marked as a history conflict is not
a fork target unless a newer owned runtime exists. Native Provider fork capability
and exact turn-boundary requirements still apply; import cannot manufacture them.

The imported model/mode/options remain the source-reported configuration. Import
never invents Role provenance or replaces the source's settings with today's
Provider defaults. Fork retains a runtime configuration baseline only at its matching
last copied user turn and source native identity, rebasing it to the target native
session. Forking an earlier turn must not inherit settings reported for a later turn.

## Evidence

- [Identity resolver](../packages/shared/src/session-acp-identity.ts)
- [Import service](../apps/cli/src/lib/local-project-history-sync-service.ts)
- [Fork service](../apps/cli/src/session/session-fork-service.ts)
- [Decision and validation](../.agents/notes/implemented/bug-fix/2026-09-28-imported-acp-session-identity.md)
