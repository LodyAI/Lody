# Project slash commands as delta rows beside the capability cache

Status: implemented
Translation: current
Language: [中文](2026-09-27-acp-command-scope-rows.zh.md)

## Abstract

Every newly created session wrote its agent's slash-command list into that agent
config's machine capability row. The list depends on the project directory the
session runs in, so each session started in a different project rewrote the whole
25–40 KB row and synced it to every client in the workspace. Measured probes show
that the commands were the only field that changed between directories. The row
now keeps one base list for each capability source version. A session records only
its project's additions and removals, in a small `acpCommandScope` row keyed by
project, and composers merge that delta over the base. Replaying real probe output,
a project switch now syncs 0–12.5 KB once per project instead of 29–42 KB every
time. Composers built before this change show only the base list, without
project-specific commands, until they update.

## Problem

`scheduleCreatedSessionCapabilityUpdate` wrote each created session's `session/new`
capabilities back into the per-config `['acpCapability', AgentConfigId]` machine
Flock row. The value is written whole, and every change syncs to all clients in the
workspace. On one development machine the rows were 4–40 KB for Claude and Codex
(mostly `availableCommands`) and 177 KB for Devin, about 700 KB across the
workspace. The daemon logs for 2026-09-25 show 207 whole-row writes. The logs could
not say which field changed. PR #760 had already removed most refresh probes, which
left created sessions as the main writer.

To find the changing field, the real probe (`fetchAcpCapabilities`) was run for
builtin Claude and Codex from four directories: the home directory, this repository,
and two other repositories. Everything except `availableCommands` was byte-identical
in all four, including every `configOptions` `currentValue`:

| Agent | Common commands | Project extras | Row size |
| --- | --- | --- | --- |
| Claude | 105 | 0–7 | 36.8–40.0 KB |
| Codex | 75 | 0–32 | 26.2–38.6 KB |

So the churn came from project-level commands and skills, not from the per-model
snapshot flips that the [per-model controls proposal](../../proposed/architecture/2026-09-27-per-model-acp-controls.md)
had suspected. Last-writer-wins also made the slash menu inconsistent: a composer
showed whichever project most recently started a session.

## Decision

- **Base list**: the capability row's `availableCommands` belongs to probes, which
  run in the daemon's own directory. A created session keeps the stored list when
  one exists for the same `sourceVersion`. Without one (first write, or an agent
  upgrade), the session's list seeds the base as before.
- **Project delta**: a created session with a project writes
  `['acpCommandScope', AgentConfigId, scopeKey]` with
  `{ sourceVersion, added, removed }`. `added` holds commands the base lacks or
  describes differently; `removed` holds base names the project does not offer. A
  delta equal to nothing deletes the row. A session that reported no commands leaves
  the row untouched. The value holds no timestamp, so repeat sessions in a project
  write nothing.
- **Scope key**: `getAcpCommandScopeKey` gives `local:<localProjectId>` or
  `github:<owner/repo>` (lower case). Worktrees of one project share a key; chat
  sessions have none and see the base.
- **Reading**: `MachineViewMeta.acpCommandScopes` carries the rows. The session
  composer, draft tabs, and chat landing pass their project's key, and
  `resolveAvailableCommands` applies the delta only when its `sourceVersion` matches
  the base. After an upgrade a project shows the base until a session there
  recomputes its delta.
- **Cleanup**: deleting an agent config in the CLI or the renderer deletes its
  scope rows. Capability rows of deleted configs were already left behind before
  this change; that gap is unchanged.
- The dedupe comparison now includes `goalActions`, so a change there alone is no
  longer skipped.

## Observability

- `[acp-capabilities] write` (debug) logs every capability write attempt: the config,
  `source=probe|session`, the outcome (`unchanged`, `renewed` or `written`), the
  changed top-level fields, the bytes written, and the scope-row outcome.
- The same line carries cumulative writes, bytes and skips since daemon start, for
  both the capability and command-scope families, so one grep gives the day's cost.
- `[acp-runtime-config] write` (debug) logs each session runtime-config snapshot
  write with its revision, bytes and `writesThisTurn`. That is the per-turn write
  amplification the per-model proposal flagged.
- `lody machine list --json --include-acp-capabilities` includes `acpCommandScopes`.

## Mixed versions

- New daemon, old composer: old composers read only the base list, so
  project-specific commands leave their slash menu until they update. Typing the
  command still reaches the agent. This was accepted rather than keeping every
  project's list in the base, which would keep the churn.
- Old daemon, new composer: there are no scope rows, and the base behaves as before.
- Old readers ignore the unknown Flock row family. The strict
  `machine/acp-capabilities-refresh_response` schema is unchanged.

## Alternatives

- **One full row per project**: each row stays stable, but each also duplicates the
  25–40 KB base for every project and agent, which every new client downloads.
- **Commands in the session document**: this would fix existing sessions only. New
  chats would still lack project commands, and every session document would carry
  the list.
- **Probe-only commands**: project skills would disappear from the menu entirely.
- **Freezing `configOptions` on model flips** (the proposal's "snapshot
  stabilization"): the measurement shows those fields never changed, so it would
  add complexity for no saving.

## Verification

- Replayed real probe output through `computeAcpCommandScopeDelta`: a project switch
  goes from 38.3–41.4 KB (Claude) and 29.4–41.6 KB (Codex) per switch to 0–3.2 KB and
  0–12.5 KB once per project.
- `apps/cli/src/lib/loro/machine-document-capabilities.test.ts` drives the real
  `MachineDocument` against an in-memory Flock. Each new mechanism was ablated and
  its test failed:
  - keeping the base;
  - the source-version gate;
  - the probe/session split.
- Shared tests cover row parsing, config-delete cleanup and delta math. A component
  test runs rows through the machine overlay into `resolveAvailableCommands`.
- Field-level write counts on real traffic come from the new log line; they have
  not been collected yet.
