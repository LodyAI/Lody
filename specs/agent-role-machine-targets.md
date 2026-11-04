# Agent Role machine targets

Status: draft
Translation: current

[中文](agent-role-machine-targets.zh.md)

## Scenario

A user with several machines wants one Role, such as Reviewer, to behave the same
everywhere. A Role used to bind exactly one `machineId + agentConfigId`, and names
must be unique, so the same Role became `reviewer-mac` and `reviewer-linux`, and
every prompt change had to be repeated per machine. This Spec makes one Role carry
several machine targets.

## Decision

A Role splits into two layers. Name, emoji, description, prompt prefix and
visibility are shared by every machine. Each **machine target** owns its Agent
Config, model, mode, run options and memory binding, plus an optional alias while
the Role has more than one target. A machine has at most one target per Role.
Target order is authoring order, not preference; there is no fallback between
targets.

The Role editor shows machine tabs below the prompt: the Role's machines first,
then every other machine the user can reach. A tab the Role does not run on offers
"Add to this machine". Adding preselects an Agent Config on that machine with the
same agent type as the first configured target, preferring the same name (a custom
agent matches by name). The run config is copied as authored; whatever that agent
does not support is listed as an issue in the editor before saving, never dropped
silently. Memory lives inside the machine tab because memory associations and
provider data belong to a machine: adding preselects an association with the same
provider and memory ID on that machine and otherwise leaves memory unlinked.
Memories on different machines are stored separately and Lody does not merge them.
Removing a target leaves the other targets and the shared fields untouched.

Settings lists Roles as one list of rows that keep one height in every state: name
and marks over what the Role runs, with its machines in a trailing column. Each
machine carries a status dot; past two they fold into "+N", and a Role on every
machine the user can reach reads "All N machines". The run summary appears once
when every machine runs the Role the same way, otherwise the row says it is
configured per machine. A binding problem turns that machine's mark to warning,
with the reason on hover, instead of adding a line.

## Mentions and dispatch

The `@` menu lists one row per Role target, in one step. A single-target Role shows
its name as before. A multi-target Role shows each row as its alias, or
`name · machine name` when no alias is set; within a Role, the composer's current
machine comes first. Availability, disabled reasons and ordering otherwise follow
the [mention contract](agent-role-mentions.md), evaluated per target. The composer's
own Role picker is already scoped to one machine and offers each Role with that
machine's target.

A mention range carries the Role ID and, for a multi-target Role, the machine ID.
A range carrying only the Role ID of a multi-target Role names no machine and stays
plain text. Acceptance freezes the resolved target (machine, Agent Config, run
config, memory) together with the shared prompt and revision, exactly as a
single-machine Role was frozen. Aliases take part in mention-token uniqueness
alongside Role names.

Agents name the target with `agentRoleMachineId` on the create tools; the CLI takes
`--machine` or an alias. A multi-target Role without a named machine is an error
listing its machines, never an automatic choice. A schedule proposal naming a
multi-target Role runs on its named machine, else on the proposing conversation's
machine when the Role runs there, and otherwise asks for a machine.

## Compatibility

New clients read all existing (v1) Role rows: a v1 Role is a Role with one target.
Single-target Roles keep being written in the v1 shape, including by automatic
[schema reconciliation](agent-role-schema-reconciliation.md), so upgrading changes
nothing for them. A Role is written in a v2 shape only while it has more than one
target. Older clients and older CLIs accept only v1, so they do not show or edit a
v2 Role and cannot overwrite its targets. Supporting older clients beyond this is
out of scope. Removing targets back to one returns the Role to the v1 shape and
drops its alias.

Frozen turns, Operations and Session provenance keep their shapes, so recovery and
history do not depend on the Role row's version.

## Open questions

- Whether agent dispatch by bare Role id may default to the target on the
  dispatching Session's own machine, mirroring the composer's ordering, instead of
  always requiring `agentRoleMachineId`.
- Whether adding a target should also offer to create a memory identity with the
  same ID on that machine; today the user links one from Memory settings.

## Evidence

- [Role model, row shapes and binding](../packages/shared/src/agent-role.ts)
- [Form model and add-to-machine suggestion](../packages/components/src/lib/agent-role-form.ts)
- [Role editor](../packages/components/src/components/settings/agent-role-editor-dialog.tsx)
- [Role list](../packages/components/src/components/settings/agent-roles-setting.tsx)
- [Mention items](../packages/components/src/components/mentions/mention-agent-role-source.ts)
- [CLI and MCP resolution](../apps/cli/src/lib/agent-role-create.ts)
- Behavior tests: `packages/shared/tests/agent-role.test.ts`,
  `packages/shared/tests/workspace-flock.test.ts`,
  `packages/components/tests/agent-role-form.test.ts`,
  `packages/components/tests/agent-role-row.test.tsx`,
  `packages/components/tests/agent-role-mention-source.test.ts`,
  `packages/components/tests/use-agent-role-schema-reconciliation.test.tsx`,
  `apps/cli/src/lib/agent-role-create.test.ts`
