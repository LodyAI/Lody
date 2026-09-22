# Dimcode builtin ACP

Status: draft
Translation: current

[中文](dimcode-builtin-acp.zh.md)

Users can select Dimcode in the Built-in provider group and identify it by its
Dimcode mark. The provider has the stable identity `builtin/dimcode` across
settings, CLI creation, and local session dispatch.

Lody starts Dimcode's stdio ACP server through npx with an exact package version.
The existing profile-owned npm cache and startup recovery handle installation
and reuse. Dimcode is not a managed-artifact runtime and is not auto-registered.
Credentials belong to Dimcode's configuration or the provider environment.

Creation uses durable provider setup: only successful live verification publishes
the provider; failure remains retryable. The dialog can observe setup and refresh
the published provider. Older machines without provider setup cannot create it.
Models, modes, and extensions come from live ACP discovery. Lody retains its title
generator until authoritative upstream title behavior has been established.

## Evidence

- [Launch resolver](../apps/cli/src/agent/setting.ts)
- [Provider dialog](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [Decision and validation](../.agents/notes/implemented/feature/2026-09-22-dimcode-builtin-acp.md)
