# Mobile conversation bottom ownership

Status: implemented
Translation: current

[中文](2026-10-11-mobile-conversation-bottom-ownership.zh.md)

## Abstract

Fast downward scrolling could compete with repeated engine writes to the bottom,
and composer layout changes could restore following without a conversation gesture.
The controller now samples elastic offsets within the real scroll range and only
re-arms following from conversation input; near-edge corrections wait for native
scroll completion. Composer content is measured outside its live flex layout, avoiding
a transient viewport expansion that loses the reading offset. Model, adapter and
Chromium and WebKit layout checks verify these paths; native iOS momentum remains
unverified.

## Diagnosis and decision

This implements the controller and composer repair from the
[original analysis](../../proposed/bug-fix/2026-10-11-mobile-conversation-bottom-ownership.md),
retaining its native-device acceptance boundary.

This partially replaces the immediate 4px re-arm and input-reset behavior described
in the [scroll-engine decision](../architecture/2026-09-27-conversation-scroll-engine.md#touch-input-and-delayed-scroll-delivery-2026-10-07),
while preserving its anchor ownership, bounded transactions and relative layout
compensation. It implements the existing [conversation intent](../../../../specs/conversation-scroll.md):
layout changes alone do not request following.

- `onScrollEvent` previously re-armed from offset/direction alone. Entering follow
  also cleared momentum, so native movement arriving afterward became unknown and
  was corrected to the bottom. Elastic offsets above the maximum caused additional
  resets, including after parent commits.
- The controller now uses bounded logical offsets for classification, anchors,
  coverage, read-back and settled checks. A rebound outside the valid range cannot
  release following or trigger a corrective write just because it is out of range.
  Relative layout compensation keeps a separate raw host offset for `scrollBy`:
  subtracting a bounded offset from the target drifts the read anchor by the
  rubber-band displacement. A write still requires logical compensation or a
  changed range that brings the elastic offset inside the range; elasticity
  alone cannot trigger it.
- Wheel and navigation-key listeners supply input evidence in both directions,
  excluding editable targets, nested scrolling and wheel zoom. Touch momentum and
  held pointers retain their existing classification. Exact-edge arrival restores
  following without clearing native evidence or adding a correction. The 4px
  near-edge case and remembered stale bottoms re-arm on `scrollend`.
  Wheel/key evidence must be directionally scrollable. Unconfirmed evidence
  expires 100ms after the first animation callback, using the injected frame clock.
  Chromium can start wheel/key motion after multiple callbacks; expiring after
  one or two callbacks can reject a real native scroll. Only input expiry is
  scheduled: these callbacks never measure, run a transaction or write offsets.
  Directional qualification uses both the last accepted and live offset because
  passive wheel delivery can follow the native position change at an edge.
  Navigation keys are observed during bubbling after row handlers can prevent
  default; button Space is excluded. Body keys require actual viewport movement
  before releasing follow: Chromium and WebKit both scroll the conversation from
  body focus after a message click, while an untouched body key does not move it.
  This closes the no-scroll
  path that has no `scrollend` and otherwise misclassifies later layout movement.
- Unknown movement and clamps discard remembered gesture bottoms. Scroll events
  sample the current viewport height before classifying a browser clamp, since
  scroll steps precede ResizeObserver delivery. Scroll frames do not sample
  content rectangles or computed padding; resize/transaction paths retain those
  measurements. Outside focus, pointer input and
  `beforeinput` cancel old evidence; typing works even when the composer already has
  focus. Explicit navigation and hiding also discard previous input evidence.
- `ChatComposer` measures a temporary hidden fixed textarea with resolved text/box
  metrics, removes it immediately, and applies the final live height once. Empty
  drafts retain the measurement-free minimum-height path.

## Evidence and limits

The owning model suite covers elastic samples, repeated commits during rebound,
input surviving exact-edge arrival, no near-edge writes before scroll completion,
unknown movement, an active gesture ending in a viewport clamp, and stale-bottom
recovery. The adapter suite dispatches wheel/key/touch events and composer focus,
pointer and editing events. Both include their prior behavioral coverage and the
model's 40 seeded sequences: the original model/adapter repair passed 103 tests.

Review regressions reproduce a 24px read-anchor drift when row growth overlaps
elastic overscroll, and stale wheel/key evidence without native movement. The
simulator now makes `scrollBy` add to the raw elastic position, and both harnesses
deliver scroll steps before input-expiry animation callbacks. Coverage includes
growth above and below a bottom reading anchor, negative top overscroll with a
changed content inset, boundary wheels, body keys, prevented row keys, button
Space, and unconfirmed scrollable wheel/key input. Confirmed input still survives
to `scrollend`, including exact-edge and near-edge arrival. Tests also cover
offset-before-wheel delivery and multiple native startup frames without movement.
The activity-row fixture now gives its synthetic upward wheel a bottom offset;
an upward wheel at offset zero cannot stand in for leaving follow.

Before/after verification uses the actual pre-fix production code at `4922c038c`
and the PR code at `4601077e2`, with the same current behavioral test fixtures in
an isolated clone. Of 12 targeted model, adapter and composer cases, 11 fail before
the fix and all 12 pass afterward. The remaining viewport-clamp case already
passed before the fix. Tests requiring the new `onReaderInput` API are excluded
from this comparison; missing-method failures are not evidence of the original bug.
The complete three-suite run on the fixed version passes all 104 tests.
After merging `main` at `a8e1cf548`, those suites and the updated conversation
backend suite pass together (109 tests); the composer browser regression also
passes again in Chromium and WebKit. The merge does not change the scroll
controller, its adapter, the composer or its measurement helper.

| Identical scenario | Before | After |
| --- | --- | --- |
| Elastic samples of +24, +18, +12 and +6px, including parent commits | Four corrective writes | Zero corrective writes |
| Native movement stops 3px short, before `scrollend` | Immediately follows and writes the bottom | Remains reading, no write; follows at `scrollend` |
| No conversation input, browser moves near the bottom, viewport shrinks 40px | Restores follow and moves another 40px | Remains reading, no additional movement |
| Active gesture, transient viewport clamp, original height restored | Reading offset loses 40px | Original reading offset preserved |
| Composer focus, editing with existing focus, or outside pointer input | Restores follow from stale evidence | Remains reading; appended output does not move it |
| React composer measurement | Live height becomes `auto` while measuring | Live height remains at its previous value |

To reproduce the targeted comparison, in a disposable clone with locked dependencies,
check out `4922c038c` and overlay only the three test files under `packages/components/`
from `4601077e2` using `git show 4601077e2:<path> > <path>`.
Do not replace production sources. Run:

```sh
NODE_ENV=test pnpm --filter @lody/components exec vitest run \
  tests/conversation-scroll-engine.test.ts \
  tests/engine-conversation-scroller.test.tsx \
  tests/chat-composer-autoresize.test.tsx \
  -t 'keeps the reading anchor when a viewport clamp|waits for the native fling|ignores elastic|never follows after|downward .* input re-arms|composer .* clears|grows through 11 rows'
```

Restore those test overlays, check out `4601077e2`, and run the same command for
the fixed comparison; omit `-t` to run all 104 related tests.

The browser regression in `tests/e2e/conversation-scroll-engine.spec.ts` executes the
production measurement helper with actual flex layout, wrapping and mixed Chinese/
English text. The owning regression passes in both Chromium and WebKit (two browser
tests). Additional layout experiments in Chromium 145 and WebKit 26.0 confirm the
restored live height still cannot recover the old offset. With a 240px composer,
the old live `auto` reset expanded the conversation viewport from 480px to 696px and lost 136px of a reading
offset 80px above the bottom; restoring the textarea height did not restore that
offset. Mirror measurement returns the same content height while leaving both the
viewport height and reading offset unchanged.

The final review regressions pass all 132 tests across the model, React adapter,
composer and activity-row suites, including the 40 seeded model sequences.
Standalone probes connect the production controller to native PageUp and wheel
input in Chromium and WebKit: upward movement releases follow, and downward
arrival at the edge restores it. These probes use synthetic row geometry and
actual browser offsets/events; they do not simulate an iOS fling.

The original CI failure was a composer fixture that assumed 48px instead of the
actual 52px padded initial height. Its corrected invariant still checks that
growth and shrink measurement preserve the live height. The original failing
components 3/3 command passed 185 files and 1,755 tests after that correction.
The final review revision reruns that same command successfully: 185 files and
1,767 tests pass.
The merged commit `b0bc3c54d` has all GitHub checks passing. The full components
run during review passed 5,105 tests and exposed two activity-row fixture failures;
both are corrected and pass in the final 132-test regression run.

Repository formatting, typechecking and linting pass. Full `pnpm check` passes
typechecking and linting, then stops after 4,002 CLI tests pass and two unchanged
Roost history cases time out at 30 seconds: signed-prefix restore/fencing, and
older-goal rejection/cache rebuilding. CLI sources and dependency manifests match
merged main; neither their assertions nor their timeouts were changed. Validation
uses locked dependencies in an isolated public clone, a neutral temporary directory,
system Git and no inherited `GIT_EXEC_PATH`, removing earlier host ESM/transport
failures. These results do not establish a fully passing local check.
I18n, Code Collab imports, platform, process and public-boundary guards passed
separately after the main merge. The scroll repair changes no manifest or lockfile;
main's SDK update is retained. Documentation checks retain the 82 baseline errors
from unavailable submodules and existing documents; no protected topics are registered.

WebKit verification uses the repository-locked Playwright build on Linux, with a
390×844 touch-capable mobile viewport for the layout experiment. Elastic controller
samples are injected by the model, not produced by a real iOS fling. These checks
do not establish native iOS animation, keyboard or gesture behavior.
Device acceptance still requires a fast downward fling, bottom
rebound, upward interruption, and typing with both a newly focused and already
focused composer. Streaming while reading and keyboard show/hide must preserve the
reading anchor; following must still track new output and final viewport changes.

## Trade-offs

There is no timer or layout retry. Animation callbacks only expire unconfirmed
wheel/key evidence against the 100ms confirmation window; they perform no
transaction or correction write. Native movement within this short window is
attributed to the qualified input; subsequent movement needs new evidence.
Hosts without native `scrollend` can re-arm at the
exact bottom or through explicit navigation, but near-edge/stale-bottom recovery
needs the native signal. Removing elastic samples by disabling overscroll was not
chosen: bounded sampling addresses engine ownership without changing native gesture
presentation. Layout compensation during real row growth retains its documented
potential to interrupt WebKit momentum; this fix does not remove that separate cost.

PR: [#1445](https://github.com/LodyAI/Lody/pull/1445).
