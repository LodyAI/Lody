# Operation rows reserve the surface gap below

Status: implemented
Translation: current
PR: [#1547](https://github.com/LodyAI/Lody/pull/1547)

[中文](2026-10-13-operation-reply-card-spacing.zh.md)

## Abstract

Operation completion and progress system rows — the "Reply received" card,
created-Session cards and batch results — rendered between turns with only the
plain 8px message pad. Above the card the previous turn's own bottom pad already
composed to the 16px surface gap, but below it only 8px separated the bordered
card from the next turn's header, so the card looked glued to what followed.
Rows containing Operation items now keep the message pad above and reserve
`surfaceGap` below, and the batch-result header keeps a small flex gap to its
cards. The trade-off is a slightly taller conversation for a clear object
boundary.

## Decision and evidence

The [rhythm Spec](../../../../specs/conversation-rhythm.md) owns the spacing
contract; it now states that an Operation system row is a rich surface between
turns. `conversationSurface.operationSurface` in `surface.ts` carries the
values, `ChatItem` applies it when a system message contains an
`isOperationSurfaceItem`, and `OperationCompletionBatchView` gained a `gap-1.5`
stack so its "N task results" label does not sit directly on the first card.

Keeping the top pad unchanged was deliberate: the card reports on the turn
above it, so it should stay closer to that turn than to the next one; growing
only the bottom reserve fixes the cramped side without loosening the
association. An earlier symmetric `paddingBlock: surfaceGap` was rejected for
exactly that reason.

## Verification and limits

`@lody/components` typecheck and Oxfmt pass; the message-content-guards and
session-relation-card suites pass (28 tests). The spacing was verified from the
row-padding composition in `view.tsx`/`surface.ts`; no before/after screenshot
was captured in this worktree, so the visual delta is asserted from the token
values (8px → `surfaceGap` ≈ 16px below the card) rather than from rendered
pixels.
