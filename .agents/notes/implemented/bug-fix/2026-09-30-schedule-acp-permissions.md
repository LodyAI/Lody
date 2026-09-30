# Schedules for ACP providers without permission controls

Status: implemented
Translation: current

[中文](2026-09-30-schedule-acp-permissions.zh.md)

## Abstract

Pi offers no permission selector, yet schedules required an explicit permission value in the editor, daemon creation and handoff. These redundant gates are removed: the composer already displays defaults, and ordinary Session/provider configuration owns runtime validation. Schedules no longer need a permission pin or a capability cache just to satisfy this extra check. Ownership, destination and credential constraints remain intact.

## Decision and evidence

The pinned Pi adapter (`693d6964`) returns only model and thinking controls.
The universal schedule permission check therefore made Pi unusable. Per the
user's clarification, remove that check entirely rather than replace it with a
provider-capability exception. Delete the shared predicate, its three callers,
unused capability reads and obsolete explicit-selection prompt. Keep composer
seeding and ordinary Session dispatch validation.

This updates the [original scheduling decision](../feature/2026-09-24-machine-owned-scheduled-tasks.md).
Current behavior is recorded in the [draft Spec](../../../../specs/scheduled-task-permissions.md).
Historical `PERMISSION_UNAVAILABLE` translations remain readable for existing logs.

## Verification and limits

Tests cover saving without a permission pin or capability cache, default seeding,
credential exclusion, CLI commands and handoff behavior. No live scheduled prompt
is dispatched. All 65 targeted tests pass, along with shared/components/CLI
typechecks, changed-file formatting/lint and i18n validation. `docs check` retains
four existing broken links into the uninitialized Kimi submodule. `pnpm format`
passed. Full `pnpm check` passed typechecks and lint, then stopped on CLI tests.
After rebasing onto current main, the three Pi capability failures pass; an unrelated
GitHub remote backfill test in `workspace-git-service.test.ts` still fails.
Code Collab, platform and public boundary guards passed separately. Remaining
full-suite checks and packaged desktop end-to-end were not completed.
