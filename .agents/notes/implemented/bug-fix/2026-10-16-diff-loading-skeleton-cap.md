# Bound the pulsing skeletons a loading diff draws

Status: implemented
Translation: current

[中文](2026-10-16-diff-loading-skeleton-cap.zh.md)

## Abstract

On iOS, opening the diff of a session with a very large change set (a user
recording shows `+0 −38677`) went white about two seconds later and reloaded the
app, every time. While the diff loads, every changed file showed a card with five
pulsing skeleton lines, and WebKit composites each pulsing element into its own
layer, so thousands of files meant thousands of layers before any diff arrived.
A loading card now draws a skeleton body only if it will open, and only the first
three such cards do; the rest wait as headers. Measured in WebKit, this removes
the memory that grew with file count; it has not been confirmed on an iOS device.

## Problem

The recording shows the same sequence twice:

1. The user taps the composer's change summary (`+0 −38677`), which opens the All
   Changes diff sheet (`mode: 'base'`).
2. Every file card shows its five-line loading skeleton.
3. About two seconds later the page goes white and the app reloads, with every
   card still loading. No diff data had been applied.

`SessionConversationDiffPanel` renders one card per changed file without
virtualization, and a card without data rendered `FileDiffSkeleton`: a header and
five `@lody/ui` `Skeleton` lines. `Skeleton` pulses with an infinite opacity
animation. In All Changes, an unfocused card starts collapsed, so those bodies
stood in for content the card would not even show.

## Evidence

A synthetic page with N cards of five 12-pixel lines, rendered in Playwright's
WebKit (WPE, 390×844 viewport at device scale 3). The table shows how much the
WebContent process grew:

| Cards | Static lines | Pulsing lines | Pulsing + `content-visibility: auto` |
| ----- | ------------ | ------------- | ------------------------------------ |
| 500   | —            | +95 MB        | —                                    |
| 2,000 | +30 MB       | +311 MB       | +130 MB                              |
| 5,000 | +59 MB       | +520 MB       | —                                    |

The pulsing animation, not the DOM, is what grows with file count. iOS backs
composited layers with GPU surfaces at three times the CSS size, so the device
cost is likely higher than this software-composited measurement. Nothing in the
recording identifies another allocation at the moment of the crash, but it was
not measured on the device.

## Decision

`selectDiffSkeletonBodyPaths` chooses which loading cards draw a body:

- only cards that will open (`shouldOpenDiffFileByDefault`): a collapsed card has
  no body to stand in for;
- at most `MAX_DIFF_SKELETON_BODIES` (3) of them, in list order.

Every other loading card renders its header alone. An unfocused All Changes diff
therefore draws no pulsing element while it loads, a focused one draws one body,
and a conversation diff (every card open) draws three bodies regardless of file
count.

## Alternatives

- **`content-visibility: auto` on file blocks.** It cut the measured growth by
  about 60% but still grew with file count.
- **A non-animated skeleton variant in `@lody/ui`.** It would fix the cost but adds
  a package option for one caller, and headers alone already communicate loading.
- **Virtualizing the card list.** This would also bound loaded diffs, but it is a
  larger change to the scroll, focus and comment-anchor code; it remains the
  right next step if loaded diffs, rather than skeletons, become the bottleneck.

## Limits

- After the fix, a huge diff still mounts one header per file and keeps every
  loaded diff in memory. All Changes inlines at most 2 MB compressed per batch,
  but then fetches every deferred file eagerly with no total budget.
- The fix is not verified on an iOS device; the crash cause is inferred from
  the recording's timing and the WebKit measurement.

## Verification

`tests/session-conversation-diff-panel.test.tsx` mounts the real panel with 300
files and a provider whose requests never settle. It checks that an unfocused All
Changes diff draws no skeleton lines, a focused one draws five, and a conversation
diff draws fifteen. Before the fix all three cases drew 1,500.
