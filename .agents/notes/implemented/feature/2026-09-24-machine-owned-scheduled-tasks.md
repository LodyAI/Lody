# Machine-owned scheduled tasks

Status: implemented
Translation: current

[中文](2026-09-24-machine-owned-scheduled-tasks.zh.md)

PR: https://github.com/LodyAI/Lody/pull/931

## Abstract

Recurring agent work used to live as a cron inside one live Agent session, so it
died with that session, was invisible to everyone else, and could not be paused.
A schedule is now a workspace document owned by one machine: that machine plans
its time slots, records each run in a local ledger and hands a frozen, inert user
turn to the ordinary dispatch watcher, so a restart or reconnect cannot run a slot
twice. People create schedules in an editor shaped like the composer or accept an
Agent's proposal card with one click; an Agent can never create one itself. The
rules people can pick are deliberately few (days, weekdays, weekly, monthly,
every N hours or minutes, once, manual) and are always read on the owning
machine's clock. Not yet verified: a packaged desktop end-to-end run.

## Decision

**Ownership and execution.** The definition is a `schedule-<id>` Loro document;
the workspace Schedule Registry Flock is the execution gate and carries a
fingerprint of the definition, so a stale or orphaned document never runs. The
owning CLI advances its cursor and records the run intent in one SQLite
transaction, then writes a `prepared` user turn and commits `latestUserMsgId` —
after that pointer the normal watcher owns execution and nothing is retried in
another session. Misfire is `skip` or `run_once`; overlap keeps at most one queued
run; execution slots are shared per Agent. A disconnected Registry blocks new
handoffs rather than risking a run the person already paused elsewhere.

**Where runs go.** A destination is a new chat per run, one chat the schedule
owns, or a chat the person picked. The owned chat's id is derived from the
schedule id and an `epoch` and never stored, so retries and other devices cannot
create a second chat and "start a new chat" is `epoch + 1`. A schedule into a
chat has no project of its own; a schedule with no project is a plain chat.

**No cron in the product.** The picker maps each named rule onto the unchanged
persisted `once | interval | cron` union. A stored rule it cannot name is shown
read-only with Replace and re-emitted verbatim. Considered and removed: a
five-field custom editor, which people found unreadable and which kept
producing lossy round trips.

**Agents propose, people create.** `lody_schedule_propose` takes a named rule and
writes an idempotent `schedule_proposal` notice; pressing Create on the card is
the creation, with the proposal id as the schedule id. The target defaults to the
proposing conversation's Agent, effective mode, machine and project; a named Role,
Agent, machine or project overrides only that part, and a named Agent gets the
builtin default mode, never another Agent's.

**Editor (2026-09-24 revision).** The editor is built from the composer's own
parts instead of look-alikes: name and prompt (split by a hairline) share one box
whose bottom edge carries the composer's Agent/model/permission controls; the
chat landing's machine, project and worktree pills sit under it; where runs go is
its own card above the time rule. This replaced four property rows. A new
schedule opens with the chat landing's last machine and Agent and that Agent's
remembered model, options and permission, so nothing starts empty; times are
typed, with no picker popup. On desktop the editor and detail open in a dialog
over the list instead of tabs, and saving returns to the list. The list itself is
worked from directly: manual rows carry a Run button, every row has a context menu
(open, run, pause/resume, last run, delete — delete confirms), and columns resize
from the header. There is no time zone control: the CLI publishes
its IANA zone as `MachineMeta.timeZone` (under 50 bytes, written at registration),
wall-clock rules and one-off times are read on that clock, and older CLIs fall
back to the viewer's zone. Save problems are marked where they are fixed — an
exclamation mark next to the field or control (never on the optional project)
— rather than listed; an unfinished
choice is marked once the person tries to save, a real conflict at once, and only
reasons that belong to no control (read-only, workspace loading) sit beside Save.
Every control is an `@lody/ui` primitive (2026-09-25 merge of the new design
system); schedule code styles layout only.

## Verification and limits

Deterministic tests cover the engine (owned chat reuses one session across runs,
manual triggers are never planned), the Sunday `0-7` weekday range across edits,
production `prepareSessionInput` for chat-only schedules, machine-clock
conversion across a DST change, save-issue placement, and the proposal target
rules. Storybook screenshots were checked in light and dark, English and Chinese,
and a narrow panel. Not verified: a packaged desktop run against a live daemon,
and the hosted account-deletion purge of schedule streams (private repository).
