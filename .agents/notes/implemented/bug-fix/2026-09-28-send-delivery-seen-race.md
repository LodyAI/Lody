# Deliver sends the CLI already marked seen

Status: implemented
Translation: current

[中文](2026-09-28-send-delivery-seen-race.zh.md)

## Abstract

After sends became local commits, a daemon that already held the session doc
could mark the new user turn `seen` before the renderer's delivery recheck. The
recheck treated any status other than `pending` as claimed, so it neither wrote
`latestUserMsgId` nor sent the dispatch RPC, and the conversation stayed at
"Starting" indefinitely. Delivery now treats `seen` like `pending`, through one
shared predicate, because `seen` is only a read receipt; only an execution state
means the CLI claimed the turn.

## Problem

`deliver()` in the workspace send journal rechecks the committed turn under the
session delivery lock and returns early when its status is not awaiting start.
Since the journal landed (`cf5c925`) the check was `status !== 'pending'`. The
CLI's auto-read observer (`apps/cli/src/lib/loro/history-auto-read.ts`) advances
the newest pending user turn to `seen` as soon as it observes it.

Before #1079 the hazard was masked: the turn was written on a fork and imported,
and the local transport did not upload imported updates, so the CLI could not
observe the turn before delivery finished. #1079 made the write a local commit
that uploads immediately. The auto-read receipt then round-trips within
milliseconds on the same machine, while `deliver()` still awaits metadata reads.

Field evidence (nightly.60, containing #1079): two idle-session sends stored as
`status: seen`, session meta `latestUserMsgId == lastHandledUserMsgId` still at the
previous turn, no `session/dispatch-turn` for that session in the daemon log, and no
renderer delivery warning, because `deliver()` returned normally.

## Decision

- `@lody/shared` exports `isSessionHistoryStatusAwaitingStart`: `pending` or
  `seen`. It is the renderer's definition of "unclaimed input".
- The delivery recheck uses it, so a `seen` turn is still activated and dispatched.
  `processing`, terminal, and `delivery_unknown` statuses still skip activation.
- The Starting-state helpers and the legacy promotion repair, which already
  encoded `pending || seen` inline, use the same predicate.

Rejected alternatives:

- Disabling or delaying CLI auto-read would restore the timing mask rather than
  fix the contract, and the read receipt is a product signal.
- Writing `latestUserMsgId` before the recheck would activate turns the CLI has
  already started or settled after a resumed send.

## Verification

`packages/components/tests/session-send-journal.test.ts` attaches the real CLI
auto-read observer to the live doc, sends an idle-session turn, and asserts it is
`seen`, the activation pointer names it, and exactly one dispatch RPC was sent.
With the old check, the same test leaves `latestUserMsgId` at the earlier turn.

Desktop journey `LODY-SESSION-005` (`e2e/src/features/session-follow-up.feature`,
`@P0`) runs the real Electron renderer and bundled CLI over the local channel with
a scripted ACP. After a first Turn completes, it sends two follow-ups, one at a
time, each to the idle Session. It asserts the agent receives every prompt exactly
once and in order, and that no unretired send remains. On a desktop build with the
old check it failed 3 of 3 runs: the first follow-up never reached the agent. With
the fix it passed 3 of 3 runs. The race depends on timing, so the unit test above
is the deterministic guard; the journey proves the product path end to end.

Limit: already-stuck sessions are not repaired by this change. Resending after
upgrading dispatches normally.
