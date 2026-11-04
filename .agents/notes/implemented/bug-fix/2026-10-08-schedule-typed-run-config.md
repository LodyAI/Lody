# Preserve ACP types in scheduled run configuration

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1306

[中文](2026-10-08-schedule-typed-run-config.zh.md)

## Abstract

Schedules reused composer controls but imposed a string-only persistence schema.
Defaults, control callbacks and proposals therefore stringified ACP booleans;
the UI converted them back while ordinary Session validation rejected execution.
Schedules now reuse the ACP value schema and derive their UI reference from the
shared Schedule contract. Capability-directed compatibility preserves existing
serialized definitions and authorization fingerprints; protocol v2 prevents new
clients from writing typed configurations for old daemons.

## Decision

The earlier [machine-owned scheduling decision](../feature/2026-09-24-machine-owned-scheduled-tasks.md)
correctly reused visual controls, but its adapters and tests encoded a second
value contract. Reuse must include data types across defaults, edits, Role and
conversation proposals, Loro persistence and the prepared Session turn. Strings
and booleans retain their types; credential filtering and size limits remain.

An unconditional `"false"` conversion would corrupt select values. Rewriting old
Schedule documents while reading would invalidate the Registry fingerprint and
frozen ledger definition. Instead, one shared projection converts exact boolean
literals only under a target boolean declaration, for UI display and the
Schedule-to-Session boundary. Session validation remains authoritative for all
other values. No provider name special case, permission bypass, reset of attempts,
or replay of dispatched work is introduced.

The daemon advertises schedules v2. Existing write/run gates require that version;
inspection, pause and delete remain possible with older targets. The new daemon
can consume old definitions and pending ledger entries. Deployment must update
the owning daemon before a new client can edit or run its schedules.

## Validation

Regression coverage checks default and proposal type preservation, rejection of
credentials/invalid values, Loro snapshot transfer with matching Registry
fingerprints, legacy projection without mutation, old-daemon save blocking and
production Session preparation for typed/legacy booleans and select strings.
Malformed boolean values still fail ordinary validation. Targeted suites (121
tests), shared/components/CLI typechecks, changed-file formatting and type-aware
lint, and documentation checks pass. Root typechecking, lint, formatting, i18n
and boundary checks also pass. Root `pnpm check` stopped at an unrelated native
Git transport test under the session-injected Git wrapper (3503 CLI tests passed).
Its six-test suite passes with injected Git variables removed and system Git;
the remaining full suites were not rerun.
No live user task was dispatched or rewritten.

Intent: [scheduled execution settings](../../../../specs/scheduled-task-permissions.md).
