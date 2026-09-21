# Preserve native text selection across the conversation window

Status: implemented
Translation: current

[中文](2026-09-20-conversation-text-selection.zh.md)

## Abstract

Conversation virtualization can unmount the DOM nodes that native text selection
references, while history eviction, streaming Markdown, and completion folding can
replace the same text independently. The implementation retains the complete
selection corridor, pins its history bodies, and holds its prose and folding
presentation until selection ends. Session updates and action controls remain live;
normal virtualization resumes when the range clears. Chromium verifies selection
continuity and native clipboard contents, but iOS selection handles and Safari still
require device verification; resource use grows with the selected corridor.

## Evidence and scope

The stream uses Virtua 0.49.1 with an 800px buffer. Before this change it did not
supply `keepMounted`. In an isolated synthetic browser experiment with 100 rows,
scrolling away disconnected the selected anchor and emptied the selection. Keeping
only the two endpoints retained only their text in the native range. Keeping every
row between them preserved all intermediate text. Increasing overscan merely moved
the failure boundary.

DOM retention alone was insufficient: the windowed history reader can evict a body
after its viewport lease releases. The renderer can also replace nodes during
Markdown reparsing, search highlighting, or finished-turn folding. Native range
lifetime therefore spans both data and presentation ownership.

This restores ordinary selection behavior in shared conversation components. It
adds no gesture, predictive interaction, or alternate clipboard format. The
[windowed reader decision](../architecture/2026-09-10-windowed-reader-integration.md)
remains in force. Image-sharing checkbox selection and the handset's edge-back
strip remain separate, as described in the
[mobile sharing note](2026-09-18-mobile-share-as-image.md).

## Implementation and lifecycle

- [`use-conversation-text-selection.ts`](../../../../packages/components/src/hooks/use-conversation-text-selection.ts)
  observes native selection and pointer events in the owning document. Pointerdown
  or selectstart arms the touched turn before the native range is established.
  Pointer cancellation allows native long-press takeover; scrolling without a range
  releases the candidate so ordinary touch panning cannot leave prose frozen.
- The selection anchor, focus, intervening turns, and the scroll destination with
  overscan form a contiguous retained corridor. A capture-phase scroll listener
  commits `keepMounted` before Virtua's scroll listener can recycle rows. Retention
  uses stable turn IDs and row keys, resolving fresh virtual indexes each render;
  it includes the real leading row offset.
- Each retained authoritative turn acquires a `ConversationRange` synchronously.
  Pins belong to the stable fact source, not a replaceable optimistic wrapper.
  When an accepted projection becomes authoritative, reconciliation acquires the
  real lease before viewport ownership can disappear. Clear, unmount, session
  change, or deletion releases leases; failed loads can retry on later selection
  activity. Deleted history is never recreated by a selection lease.
- [`view.tsx`](../../../../packages/components/src/components/ai-gui/view.tsx) holds
  the retained turns' fold/search expansion inputs, suppresses follow corrections,
  and cancels pending outline jump correction when selection starts.
  [`markdown-renderer.tsx`](../../../../packages/components/src/components/ai-gui/markdown-renderer.tsx)
  holds prose, parser inputs, and search decoration inputs; user text blocks use the
  same presentation hold. Actual session facts and action state continue updating.
  Clearing the selection renders current content and releases retention without
  forcing the reader back to the bottom.
- Native `copy` is left intact when all selected rows are mounted and hydrated.
  An incomplete range cancels copy and displays a localized retry message instead
  of silently copying a hole. The implementation does not synthesize plain text or
  overwrite clipboard formats.

## Alternatives and trade-offs

Predicting selection intent does not repair disconnected DOM nodes. Larger fixed
overscan and endpoint-only pinning both leave a correctness gap. Disabling all
virtualization would remove its performance benefit, and switching to a separate
static reader would introduce a second interaction surface. The chosen retention
is local to an active selection and uses existing history leases.

Selecting across a very long conversation can retain many DOM nodes and history
bodies. There is no arbitrary cap that silently truncates the native range. Selected
prose temporarily stops presenting streaming changes; those changes remain in the
session model and appear after release. This does not promise preservation through
explicit destructive actions, arbitrary renderer type changes, or browser Select
All spanning history that has never been mounted.

## Verification

The synthetic `NativeTextSelection` Storybook story uses real Loro history, 120
turns, a hydration budget of eight, and a leading row. It provides selection clear
and turn-completion controls without captured user content.

- Six focused behavioral tests cover full-interval retention, selected text-node
  identity, actual history eviction after release, incomplete-copy recovery,
  cancelled touch selection, ordinary touch pan, and optimistic-to-authoritative
  lease transfer (some cases share a test).
- The neighboring row identity, turn layout, Markdown, sticky scrolling, and
  conversation hook suites passed: 92 tests across eight files.
- Browser tests exercise native pointer selection and clipboard copying across
  41 turns, reverse selection through a recycled window, and completion folding
  while an earlier paragraph remains selected; all three passed. Reverse selection
  starts at the initial tail and extends through all 120 turns. They use observable state rather
  than fixed delays. Browser runs use local Chromium 151 via a temporary launch
  configuration because the pinned Playwright browser download was incomplete.
- Component type checking and root `pnpm format` passed; scoped lint reported
  zero errors (57 existing warnings). Docs checking retains the baseline 28 errors
  and 34 warnings; no new link errors or unrelated documentation repairs.
  Root `pnpm check` stopped in `packages/ignore` type checking because that
  package lacks installed dependencies (`node:*` types and `vitest`); subsequent
  root check stages did not run.

Reproduce with `NODE_ENV=test pnpm --filter @lody/components test
conversation-text-selection.test.tsx chat-virtual-rows-identity.test.ts
plan-turn-virtual-rows.test.ts markdown-idle-rerender.test.ts
markdown-streaming-reparse.test.ts use-sticky-scroll.test.ts
sticky-scroll-virtua.test.tsx conversation-view-hooks.test.tsx --maxWorkers=2`,
`pnpm --filter @lody/components typecheck`, and (with Storybook and Playwright
Chromium installed) `pnpm --filter @lody/components exec playwright test
conversation-text-selection.spec.ts --workers=1`.

The working tree uses dependencies installed in a disposable standalone clone,
linked through ignored `node_modules`. That clone required a non-frozen install
because an existing ACP submodule manifest differed from the root lockfile; this
change does not alter repository manifests or the lockfile. No desktop packaging
build or iOS/Safari device acceptance is claimed.

Device acceptance remains: long-press and drag both iOS handles across several
screens, reverse direction, release the finger and resume dragging, invoke the OS
copy menu, receive streaming text and completion while selected, and verify normal
scrolling/follow behavior after clear. Test outside the edge-back strip as well as
near it to distinguish independent gesture ownership.
