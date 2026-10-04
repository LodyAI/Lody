# Machine-scoped memory identities for Agent Roles

Status: implemented
Translation: current

[中文](2026-10-04-agent-role-memory.zh.md)

## Abstract

Roles previously had no reusable memory identity. This change adds a machine-routed
memory provider boundary and a Nowledge Mem adapter, with Settings discovery and
creation plus Role association. Only identity references enter Role and turn storage;
providers retain the actual memories. References are frozen through dispatch,
preparation and Operation recovery, and an identity change requires ACP process
restart. Agent-side Mem plugin installation remains a separate prerequisite.

## Decision and evidence

The [draft Spec](../../../../specs/agent-role-memory.md) extends the existing
[Role discovery contract](../../../../specs/agent-role-mentions.md). The old
“no memory” catalog restriction now excludes memory contents and credentials,
while allowing non-secret identity references. Existing Role visibility and
local catalog durability remain unchanged.

The installed nmem CLI documents a required positional enrollment ID and optional
name, description, role and default Space. Status returns a top-level `status`;
identity listing returns `agentProfiles` containing `id` and `displayName`.
Enrollment is create-only, so Lody refreshes the authoritative list instead of
pretending an existing ID was updated. Tests use synthetic profiles only.

```text
Settings / Role editor → machine RPC → provider probe/list/enroll
Role reference → frozen turn / Operation → preparation compatibility
               → ACP spawn environment → Nowledge agent identity
```

Putting shell commands or raw environment maps in the shared catalog would make
future providers easy to add but expose a command-execution configuration surface.
Instead commands and environment mapping stay in daemon adapters; the UI consumes
common statuses, identity records and basic creation fields. It also preserves
machine/runtime ownership so late replies cannot replace a newly selected machine.

## Validation

Adapter tests cover missing/inactive services, malformed responses, literal argv
and enrollment/list results. Role, Loro input, preparation, Operation, machine
routing and ACP spawn suites exercise the frozen reference. The execution suite
(149 tests) also checks identity switching and unlinking through process restore;
manager coverage checks that retirement emits no old lifecycle events.

Type checks, lint, i18n, platform/public boundaries and docs checks pass. Electron's
199 tests pass. Storybook browser checks cover ready, empty, missing installation,
inactive, offline and loading states, plus accordion interaction, without page errors.

`pnpm check` is not green: existing GitHub remote recognition fails in one
`workspace-git-service.test.ts` case and three `shared/tests/local-project.test.ts`
cases. The workspace-service failure was reproduced from `git show HEAD:<path>`
versions of the test and its runtime source dependencies in an isolated temporary
fixture; disabling global/system Git config also did not resolve it. No unrelated
Git behavior was changed. Checks do not imply human approval of the draft Spec.
