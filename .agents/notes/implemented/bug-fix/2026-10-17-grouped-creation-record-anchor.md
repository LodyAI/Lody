# Keep a reading anchor on a creation record that is grouped away

Status: implemented
Translation: current

[中文](2026-10-17-grouped-creation-record-anchor.zh.md)

## Abstract

A conversation whose reader rested on a session-creation card could crash with
`ConversationScrollUpdateLoopError`. Consecutive creation records render as one row
under the first record's key only while that first record is hydrated, and hydration
follows the reported scroll offset. When the grouping hid the anchored record's own
row, the anchor resolver did not know the row still contained it and fell back to a
distant turn; that offset moved the hydration window, which ungrouped the record and
restored the original offset. Grouped rows now list the turns they contain, and the
resolver lands on the containing row, so the second state is stable. Why the
production fallback landed about 9000px away is not established.

## Evidence

The copied engine diagnostics for the crashed session alternated on every commit,
all with `movement=none`, one transaction pass and covered viewports:

- `resolvedKey` equal to the anchor `operation-progress:…` key, target 14347;
- `resolvedKey` an unrelated `…:worked-header` row, target 5336.

The anchor never changed, so the row list itself flipped between two shapes. Each
flip is one synchronous commit from the scroller's layout effect, through
`onScroll` → `reportVisibleTurnRange` → `setVisibleRange`, until the 24-commit
[update-loop guard](2026-10-13-scroll-update-loop-guard.md) stopped it. An explicit
retry restored the same anchor and repeated the cycle.

The shape change comes from `buildChatVirtualRows`: it combines consecutive pure
creation records under the first record's key, and an unhydrated turn ends the group
(see the [created session list](../feature/2026-10-11-created-session-list.md)).
The loop needs the record before the anchored one (X) to sit near the hydration
window's top edge:

1. X is a placeholder, the anchored record has its own row, the anchor resolves.
2. The reported offset moves the window to include X, which is already in memory and
   hydrates in the same render. X now heads a group that contains the anchored record.
3. `resolveAnchor` matched rows only by `turnId`, which is the group head's. No rule
   found the anchored turn, so the turn-removed fallback chose another turn.
4. That offset moved the window away from X, X became a placeholder, and step 1
   returned.

## Decision

`EngineRow.groupTurnIds` lists the further turns a row renders. `view.tsx` fills it
from `groupedItems`. `resolveAnchor` checks it after the same-turn rules and before
the turn-removed fallback, landing on the containing row at offset 0. In step 3 the
reader stays at the group, the reported range keeps X in the window, and the grouped
shape persists.

Offset 0 drops the reader's position inside the record. The card's position inside
a group's internal list is not known to the engine, and the group's top is at most a
few compact rows above it. Rule 1 still returns the record's own row when grouping
ends.

Alternatives considered:

- Turning grouping off removes this loop but regresses the created-session list, and
  any other row whose key depends on hydration could loop the same way.
- Hydrating whole creation runs together keeps keys stable in this case, but leaves
  the resolver blind to grouped turns in message-selection and other row changes.
- Moving hydration updates out of the synchronous chain would only slow the
  oscillation; the anchor would still alternate between two positions.

## Verification and limits

A model test in `tests/conversation-scroll-engine.test.ts` feeds each reported
offset back into the row shape, with c0/c1 grouping controlled by the window. It
throws `ConversationScrollUpdateLoopError` without the resolver rule and settles with
c0 at the viewport top with it. The anchor in that test carries an out-of-date turn
index so the fallback lands far away, as in production. Whether production turn
indexes go stale, or the fallback lands far for another reason, is not established;
the turn-removed rule still depends on `turnIndex`.
