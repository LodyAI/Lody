# Scheduled task permission capabilities

Status: draft
Translation: current

[中文](scheduled-task-permissions.zh.md)

The schedule editor uses the composer's displayed Agent defaults, including any
permission controls the provider offers. Saving, daemon creation and run handoff
must not impose a separate explicit-permission requirement or require a capability
cache solely for that check. Omitted run-config values follow ordinary Session
and provider defaults. Pi and other providers without permission controls need no
synthetic mode.

The regular Session preparation and provider configuration paths continue to
validate supported execution settings. Machine ownership, Agent availability,
destination checks and credential exclusion remain unchanged. Removing this
redundant gate does not automatically approve provider permission requests.

## Evidence

- [Shared validation](../packages/shared/src/schedule-types.ts)
- [Schedule UI](../packages/components/src/components/schedules/AGENTS.md)
- [Daemon scheduling](../apps/cli/src/lib/schedules/AGENTS.md)
