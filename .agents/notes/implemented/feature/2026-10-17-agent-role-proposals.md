# Agent Role creation and update proposals

Status: implemented
Translation: current

[中文](2026-10-17-agent-role-proposals.zh.md)

## Abstract

Agents could read Roles but could not apply reviewed instruction changes without
manual copying into Settings. MCP and CLI now propose creation and text updates in
a conversation card, whose Save action applies the change. Both surfaces use one
bounded schema and the existing catalog writer; concurrent device edits retain the
existing overwrite behavior instead of adding distributed revision coordination.
Existing accepted Session operations keep their frozen configuration.

## Decision

[Issue #1624](https://github.com/LodyAI/Lody/issues/1624) motivates this feature.
The adopted scope includes creation and update on MCP and CLI, human confirmation,
and simple last-writer behavior. This extends the
[CLI Role selector](2026-10-07-cli-session-create-agent-role.md); it does not change
dispatch or the [Role description](2026-09-28-agent-role-description.md) contract.
A separate direct-write API and cross-device locks were deliberately omitted.

```text
MCP / CLI -> active Session tool -> durable proposal notice
user Save -> latest Role + text patch -> existing catalog writer
          -> saved notice receipt
```

Creation requires an explicit machine/config binding, creates a private Role with
Agent defaults, and carries a stable generated Role id. Updates require management
permission and expose only name, description and promptPrefix. An omitted field is
preserved; an empty optional field clears it. Save rechecks the requesting user,
Role existence/ownership and mention-name uniqueness. It increments revision only
on an effective change, without rejecting concurrent edits on revision mismatch.

The card stores the original bounded request and before-values for review. Repeating
a request id returns its outcome or rejects changed input. A repeated create Save
keeps an existing Role with that id. A failed notice receipt after a durable update
can be retried; applying an identical patch is a no-op. A later concurrent edit may
be overwritten on retry, consistent with the accepted concurrency trade-off.
CLI proposals require an active conversation; they do not silently bypass consent.
All writable fields also have direct CLI flags: name, description and prompt-prefix,
plus machine-id and agent-config-id for creation. Direct fields and JSON --file are
mutually exclusive, keeping input precedence explicit. Both modes share schema and
tool routing; omitted fields are preserved and empty optional text clears it.
Command tests cover full direct inputs, clearing, omission, missing required fields
and rejection of mixed input modes.

## Ownership and validation

The existing Session tool registrar owns validation/routing and the daemon owns local
history. The renderer authors the catalog and confirmation receipt. The workflow adds
no background worker or lifecycle resource. Effect feature/fix assessment retains the
existing Promise Session/document boundary: migrating it would require the unfinished
upstream document orchestration, outside this feature. CLI local IPC uses the existing
native Effect client at its command entry.

Behavior tests cover field preservation, deletion/ownership/name failures, bounded
inputs, real Loro history retry receipts, and card Save/Dismiss/failure recovery.
Workspace type checks, lint, Effect lint, i18n and architecture boundary guards pass.
The broad CI test run encountered the existing Git transport fixture inheriting this
Session’s Git wrapper via its environment; that file passes all 24 tests with Git/SSH
environment variables and the Session shim PATH entry removed in the test process.
The confirmation card has component tests and Storybook states; browser visual QA
was unavailable because this environment exposes no browser control surface.
Implementation and command examples: [tool guide](../../../../apps/cli/src/mcp/README.md#agent-role-proposals).

## Ablation validation

Candidate removals were tested individually. Removed duplicate command parsing and
Role permission preflight from the proposal service. MCP/daemon registration still
validates input; the shared apply function checks ownership, deletion and name conflicts
before publication and again on Save. Updates retain the command's Role id instead
of generating an id for a missing Role. A real Loro history test verifies that owned
updates publish a card while missing or unowned Roles add no history.

- Removing duplicate service parsing: 74 proposal, command and MCP server tests pass.
- Removing duplicate permission preflight: 24 proposal and command tests pass.
- Removing the remaining shared permission check: the new history test fails; restored.
- Removing create retry protection: one test fails. Removing unchanged-update protection:
  two tests fail. Both guards were restored; they prevent retries from replacing later
  edits and unchanged updates from incrementing revision.

These ablations support the local simplification, not a claim about untested paths.

CLI creation/updates use daemon `session/call-tool` in both compositions, following #1628 replica ownership. Command coverage includes cloud routing and exact machine/workspace scope.

Pre-PR verification on main `2e14ab065`: full CLI 4309 pass / 4 skipped and full components
5406 pass. `pnpm check` passes typecheck, lint and Effect lint, then stops at two failures
in untouched e2ee-core: mailbox WAL snapshot worker watchdog timeout and receive
queued-original cross-process `sign-failed`. The latter also fails in isolation
(13 pass / 1 fail); remaining packages did not complete. The check process excludes
inherited Git/SSH Session wrapper environment, and CLI Git transport now passes.
