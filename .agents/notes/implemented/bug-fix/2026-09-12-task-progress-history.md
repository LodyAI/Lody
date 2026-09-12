# Preserve task lifecycle progress in session history

Status: implemented
Translation: pending

## Abstract

ACP adapters publish bounded task lifecycle state through `_meta.lody.task`, but
the CLI filtered nonterminal `tool_call_update` notifications before the shared
history applier could materialize them. This left running subagent tool names and
usage stale until a terminal event. Valid task metadata now passes the filter
while generic running tool snapshots remain excluded. Task merges preserve the
original actor, purpose, and background state, reject late progress after a task
settles, and still allow explicit lifecycle updates such as Codex `resumeAgent`
to reopen it.

## Context

Issue #445 identified the filtering boundary. PR #446 by @audichuang supplied the
initial persistence approach and regression coverage. Its review found three
merge hazards that this follow-up incorporates: activity text replacing the task
purpose, foreground-looking progress erasing background state, and a blanket
settled-state guard blocking an explicit Codex resume. PR #446 was closed without
merge or a successor, and current `main` still exhibited the original gap.

## Decision

- Admit a nonterminal tool update only when `parseLodyTaskMeta` accepts its
  `_meta.lody.task` payload. This reuses the same schema as materialization and
  does not broaden generic tool history.
- Carry the validated lifecycle `event` in provider-neutral metadata so the
  history merger can distinguish ordinary late progress from explicit Lody
  starts and updates. The shared Claude/Kimi converter emits the source subtype.
- Merge task snapshots by `taskId`. The first known actor and description remain
  the durable identity and purpose; current activity continues to update
  `lastToolName`, usage, summary, and terminal fields.
- Treat background state as sticky because current lifecycle snapshots have no
  explicit foreground transition. A later `kind: subagent` activity snapshot is
  not sufficient evidence to foreground the task.
- Ignore nonterminal events after completion or failure unless the incoming event
  is explicitly `task_started` or `task_updated`. This drops late progress while
  preserving the Codex `resumeAgent` path, which emits `task_updated`.

No Spec change is needed: this restores the existing provider-neutral task
history contract and its bounded-history guarantee rather than introducing a new
user-facing workflow or persistence model.

## Verification

Focused shared tests cover stable identity/purpose, sticky background state, late
progress, explicit Lody start/update resumes, and Codex resume. Converter tests
pin lifecycle event emission for both Claude and Kimi. CLI history tests cover
schema-valid Lody progress, usage/tool state, invalid/generic filtering,
single-item upsert, and terminal settlement.

The implementation was derived from and explicitly credits #446; no code from
that closed branch is merged directly.
