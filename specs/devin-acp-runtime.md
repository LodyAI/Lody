# Devin ACP runtime

Status: draft
Translation: current

[中文](devin-acp-runtime.zh.md)

A user can add the registry Devin provider without first installing the Devin CLI globally.
Lody uses the official platform binary published by the ACP registry, downloads it through the
registry binary installation flow, caches it under the active installation profile, and launches
its `acp` command. Provider setup exposes download progress and a retryable failure when the
artifact cannot be installed.

The registry entry is the version and platform source of truth. An unsupported operating-system
or architecture combination must fail as unsupported instead of falling through to an unrelated
global command. A user who intentionally wants a separately installed Devin executable can add a
Custom ACP provider with that command and arguments.

## Evidence

- [Registry generation](../scripts/generate-acp-registry.mjs)
- [Registry binary installation](../apps/cli/src/agent/acp-binary-manager.ts)
- [Launch resolution](../apps/cli/src/agent/setting.ts)
- [Decision](../.agents/notes/implemented/bug-fix/2026-09-18-devin-managed-binary-restoration.md)
