# Dimcode builtin ACP

Status: draft
Translation: current

[中文](dimcode-builtin-acp.zh.md)

Users can select Dimcode in the Built-in provider group and identify it by its
Dimcode mark. The provider has the stable identity `builtin/dimcode` across
settings, CLI creation, and local session dispatch.

Lody starts the user-installed `dimcode acp` command from the target machine's
agent PATH. Users install an ACP-compatible version and manage upgrades themselves.
Lody does not install, pin, upgrade, or download a fallback for builtin Dimcode.
Its child process disables upstream automatic update checks and background installs;
this does not change the user's terminal environment. Credentials and local state
remain in Dimcode's configuration or the provider environment, not a private Lody home.
Dimcode is not auto-registered.

Existing builtin configurations switch to this user-installed command without changing
provider identity. Old Lody npm caches are left untouched. Legacy registry configurations
retain their separate launch contract. The capability source key changes once to invalidate
the previous pinned-runtime cache; after user upgrades, explicit Refresh discovers current
capabilities, as with Bub.

Creation uses durable provider setup: only successful live verification publishes
the provider; failure remains retryable. Missing commands or unsupported ACP subcommands
show a short missing-command hint with the copyable `npm install -g dimcode` command,
without triggering an install. The dialog can observe setup and refresh
the published provider. Older machines without provider setup cannot create it.
Models, modes, and extensions come from live ACP discovery. Lody retains its title
generator until authoritative upstream title behavior has been established.

## Evidence

- [Launch resolver](../apps/cli/src/agent/setting.ts)
- [Provider dialog](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [Decision and validation](../.agents/notes/implemented/feature/2026-09-22-dimcode-builtin-acp.md)
- [User-managed runtime decision](../.agents/notes/implemented/simplification/2026-10-10-dimcode-user-installed.md)
