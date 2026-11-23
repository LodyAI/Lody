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

## Typed execution settings

Sharing the composer controls also means sharing ACP's `string | boolean` value
contract. Defaults, edits, conversation/Role proposals, persisted definitions and
prepared Session turns preserve that type; a select string `"false"` is not a
boolean. Credential exclusion and bounded option sizes still apply.

Schedule protocol v2 advertises this contract. New clients require v2 for
create/edit/resume/run; inspecting, pausing and deleting remain available for
older machines. Older definitions remain readable without rewriting their
Registry fingerprint, activation or frozen run identity. For display and handoff,
exact legacy `"true"`/`"false"` values are converted only for options the target
Agent declares boolean. Unknown options and other values remain subject to
ordinary Session validation; missing capability data does not authorize guessing.
This compatibility does not re-run exhausted or already dispatched work.

## Evidence

- [Shared validation](../packages/shared/src/schedule-types.ts)
- [Schedule UI](../packages/components/src/components/schedules/AGENTS.md)
- [Daemon scheduling](../apps/cli/src/lib/schedules/AGENTS.md)
