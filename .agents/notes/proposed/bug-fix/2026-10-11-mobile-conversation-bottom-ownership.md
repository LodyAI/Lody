# Separate native edge motion from conversation follow intent

Status: proposed
Translation: current

[中文](2026-10-11-mobile-conversation-bottom-ownership.zh.md)

## Abstract

Fast mobile scrolling at the conversation bottom can make native edge motion compete
with the engine's bottom correction. The current controller also restores following
from downward browser movement without conversation input, allowing later composer
resizes to move a previously reading conversation. Model probes confirm repeated
correction of elastic offsets, premature touch-fling snapping, and input-free follow
rearming. The proposed repair separates logical position, native motion, and reader
intent; product code is unchanged and native iOS verification remains open.

## Findings and evidence

The subsequent [implementation and verification](../../implemented/bug-fix/2026-10-11-mobile-conversation-bottom-ownership.md)
in PR #1445 records the completed controller/composer work and browser evidence;
this proposal retains the original diagnosis and native-device acceptance work.

This extends the [scroll engine decision](../../implemented/architecture/2026-09-27-conversation-scroll-engine.md),
especially its October 7 delayed-touch fix and invariant I8, and targets the existing
[scroll intent](../../../../specs/conversation-scroll.md) rather than changing it.

- In `controller.ts`, `onScrollEvent` rearms within 4px on any downward offset,
  without testing `movement` or qualifying conversation input. Its subsequent
  non-read branch starts a correction transaction. `setIntent(follow)` clears
  momentum immediately, although the native sequence may still be running.
- The host reads raw DOM `scrollTop`. Neither the controller nor adapter separates
  out-of-range elasticity from content position. Safari reports offsets beyond the
  scroll range during bounce ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTop)).
  A sampled bottom overshoot therefore differs from the clamped follow target and
  triggers an absolute write. The engine is the only programmatic writer; the other
  participant in this feedback path is native scrolling.
- `gesture` is created for arbitrary scroll movement. `writePhase` records historical
  maxima during layout changes, including viewport changes. `rearmAtGestureBottom`
  checks a downward offset and a historical maximum but has no reader-input source
  check. Layout-derived historical bottoms must not serve as proof of user intent.
- The session input passes `autoResize` to `ChatComposer`. On each nonempty draft
  change its effect sets the live textarea's height to `auto`, reads `scrollHeight`,
  and restores a clamped height. This can temporarily grow the sibling conversation
  viewport and clamp its offset before final layout recovers. The model confirms
  that an unobserved clamp followed by recovery becomes `unknown` and replaces a
  read anchor; whether the actual mobile DOM produces this sequence is unverified.
  Keyboard lift also changes composer layout. Neither event should rearm follow.

## Reproducible model observations

Use the real `ScrollController` through the existing `ScrollSim`, with forty 100px
rows, matching estimates, a 600px viewport and its default 24px top/bottom insets.
The settled maximum is 3448px. Compile the simulator and its controller dependencies:

```sh
tsc --target es2022 --module commonjs --moduleResolution node --strict \
  --skipLibCheck --outDir /private/tmp/lody-mobile-scroll-probe \
  --rootDir packages/components packages/components/tests/support/scroll-engine-sim.ts
```

1. Override the host read to add an elastic offset, clearing that offset on an
   absolute write. After touch start/end, inject +24, +18, +12 and +6px samples,
   calling `onScrollEvent` in separate simulator tasks. All four trigger a write
   to 3448px. This proves the controller response to elastic samples, not native
   compositor oscillation on the reported phone.
2. Release follow and move to 3348px. Start/end a touch and move to 3445px before
   `scrollend`. The controller switches to follow and writes 3448px.
3. Jump to row 30, then inject an offset of 3445px with no pointer/touch input.
   The controller switches read → follow. Resize the viewport from 600 to 560px;
   it moves to 3488px. This demonstrates how false rearming propagates into a
   later composer/keyboard resize, without claiming that focus always moves there.
4. Read at 3368px; temporarily grow the viewport to 720px and apply native range
   clamping, then restore 600px before delivering the event. The engine adopts
   3328px as its new read anchor and later commits keep it there. This is a model
   of a transient textarea measurement, not proof of the app's layout sequence.

All four diagnostic probes and the existing 70 model tests pass using cached
Vitest 3.2.4 with an isolated temporary configuration. The probes assert current
defects; they are temporary research artifacts, not passing regression tests for
a repair. The real controller/simulator dependency graph also passes strict `tsc`.
This checkout has no workspace dependencies, so the normal package runner is
unavailable. A desktop WebKit layout experiment aborted during browser launch;
no browser or native-device result is claimed.

Before PR creation, root `pnpm check` and `pnpm format` were attempted and stopped
on missing `tsgo` and `oxfmt`, respectively. `pnpm run docs check` reports 82
existing repository errors, with none referencing this note pair; `git diff
--check` passes. No protected documentation topics are registered.

## Proposed repair

1. Keep raw and logical offsets distinct. Use range-clamped logical offsets for
   anchors, direction, coverage and snapshots. Treat elastic displacement and its
   return as native edge motion, preserving intent and avoiding correction writes
   caused solely by that displacement. Apply this across scroll, commit and resize
   entry points; clamping only `readScrollTop` still lets `writePhase` fight bounce.
   Genuine layout compensation remains a separate transaction responsibility.
2. Track qualifying conversation input for both directions: touch, wheel, navigation
   keys and scrollbar drag. Unknown movement, range clamps and own writes may update
   observation/coverage but never provide evidence to rearm follow. Historical
   bottom matching must belong to that input sequence; viewport/composer changes
   alone cannot create candidates or revive an old sequence.
3. During touch/fling, record bottom arrival without clearing native-motion evidence
   or forcing a 1–4px snap. Settle eligible arrival on `scrollend`. On hosts without
   that event, logical bottom arrival may rearm without a correction write while
   retaining qualified touch evidence through the native sequence. Explicit latest,
   send and jump commands supersede it. Do not add a timer fallback. Distinguish
   actual upward input from the bounce returning toward an in-range bottom.
4. Measure composer text outside live layout, using a noninteractive measurement
   element with matching width/font/wrapping/padding, and apply only the final
   height. Preserve minimum height, the 11-row cap, placeholder behavior, textarea
   scrolling and focus. This removes a plausible transient clamp source while the
   controller repair closes false rearming independently.

Keep the existing one-writer, extent, anchor and bounded-coverage contracts. Merely
increasing tolerances or debouncing correction leaves the intent error intact.
Disabling bounce with `overscroll-behavior-y: none` is a possible product choice,
but cannot by itself repair input-free rearming or transient composer clamps.

## Acceptance for implementation

Extend the owning model and adapter suites with elastic offsets/return, sampling
from commit and resize before scroll delivery, touch arrival before `scrollend`,
new output during the native sequence, genuine upward escape and explicit latest.
Add unknown movement/clamp/own-write cases that must remain read, historical-bottom
cases spanning viewport resize, and downward wheel/key/thumb rearming. Preserve
the existing stale-estimate bottom recovery, coverage and seeded-sequence checks.

Composer browser acceptance must verify real sibling offsets across wrapped typing,
deletion, IME updates and keyboard open/close while read and while follow. Test the
reported rapid downward fling on an iOS device with raw/logical offset, max range,
input source, intent transition and write reason traces. Synthetic tests cannot
establish native momentum or whether the reported visual vibration is gone.

PR: [#1465](https://github.com/LodyAI/Lody/pull/1465).
