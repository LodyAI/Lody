# A bounded StyleX extraction route for legacy cascade contracts

Status: proposed
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[中文](2026-10-31-stylex-cascade-compatibility.zh.md)

## Abstract

Moving public Tailwind defaults between CSS layers changes supported caller precedence. An early flat-utilities route preserves 66 existing browser pairs and the visible native row in a real Electron trial, but three additional arbitrary-property callers change width, minimum width and hit testing. Named utility controls still match: the failure is the original ordering between named and arbitrary-property rules, which `twMerge` does not remove. All thirteen trial source/configuration/dependency paths were restored and its nine defaults receive zero migration credit. Ordering-aware replacement remains proposed; private owned UI migration continues independently.

## Evidence and limits

The [migration note](../../implemented/architecture/2026-10-22-tailwind-to-stylex-migration.md) owns completed migration and its inventory. Local evidence is `packages/components/artifacts/visual/leaves156-acceptance.html`, with the original captures, failures and an embedded reproducible experiment. These are real browser results from isolated source and compiler inputs; they earn no product migration credit.

| Experiment                                                                                                    | Observed result                                                                                                  | Limit                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native `utilities.priorityN` sublayers                                                                        | All nine zero-specificity ancestor cases change                                                                  | Unlayered rules inside `utilities` still outrank its sublayers.                                                                                                     |
| Separate import namespace and class prefix; native metadata extraction into flat `utilities`, before Tailwind | All thirteen Adaptive cases match complete recorded fields and PNGs; the ordinary StyleX control stays unchanged | Radix Slot grid-parent/flex-child changes grid to flex and height 55 to 28px.                                                                                       |
| The same extraction placed after Tailwind                                                                     | Repairs that Slot direction                                                                                      | Breaks the reverse Slot direction, direct caller width 840 to 0, and the retained 366px query's active minimum 180 to 0; none of the thirteen Adaptive cases match. |
| Reusing ordinary atom names across the two routes                                                             | Adaptive cases match                                                                                             | Promotes a shared atom into `utilities`; an ordinary StyleX control changes overflow from visible to hidden despite identical pixels.                               |

The original 159 client-build prototype uses a private 96-line extractor for one fixed
native owner. Storybook and a production Vite consumer of the real SessionTabBar
both build successfully with 2,401 inputs stable; eight Root source/configuration
and lock guards remain unchanged. All 66 PNG pairs match byte-for-byte. Complete
recorded ordinary/custom/pseudo fields, attributes, state, geometry and animation
snapshots match after only the owned class carriers are replaced; 46 ordinary
StyleX controls match without that normalization. The ordinary and unlayered CSS
rules retain their conditions and relative order, and native atoms stay out of the
normal collector. Workspace evidence is `leaves159-field-comparison.json`,
`leaves159-css-asset-audit.json` and the independent
`root159-native-route-independent-verification.json` under the visual artifact
directory. These results earn zero production migration credit.

The 159 extractor must run before React/docgen source transforms; its strict raw-source
equality rejected the original later wiring. Its seven constant atoms fold every
StyleX call, so no dynamic runtime alias was exercised. That version deliberately rejects
dev/HMR, build-watch and SSR; its generated file and private compile cache do not
yet establish safe ownership across concurrent development servers. At that boundary, source maps,
directly declared compiler dependencies and an actual paired Electron renderer
run remained adoption requirements. The second client build is a standalone
consumer, not the Electron App. The existing renderer-only verification path can
hold main/CLI bytes fixed without invoking ACP prerequisites.

A 31-line owner-only reload extension (164) passes ordinary edit/delete/failure
checks but fails a real cross-response window: an old owner JS response is already
in flight while the page receives newer CSS, with HMR disconnected. The old center
atom is absent from that stylesheet and actual alignment becomes `normal`.
The original payloads and browser image remain in `leaves164-acceptance.html`.
Its separate initial-spacing pixel OPEN is 55 raw/32 threshold pixels; locating
those pixels in recorded native items and the trailing plus glyph does not prove
a paint cause.

The next isolated extension (168) retains successfully published atoms in a private
per-server development history and uses an exact import alias to an owned UUID
CSS file. The same in-flight response window then retains center alignment; real
edit/delete, failed compilation, rapid changes, two-server separation and pending
close checks pass. Twelve new cold pairs match PNG bytes and fields, with eight
ordinary controls unchanged; current-production seven-atom CSS matches 159 bytes.
These results do not close 164's original OPEN. The initial production path still
writes one fixed generated file, so parallel production ownership is not yet safe.
All client modes need private output before adoption. Node tests also import this
owner through Vitest's SSR transform: they need an explicit compile-only macro,
without treating that as application SSR support. Direct pinned compiler imports,
complete consumer type coverage and actual paired App verification remain under
review. No Root production route is adopted by these experiments.

The original five direct-caller frames omitted `items-end` from the fixture's Tailwind candidate list. They remain rejected evidence. Only those five cells were corrected and captured again after proving the stylesheet changed solely by the missing rule; sixty healthy cells were retained.

The installed 0.19 unplugin cannot be treated as two isolated collectors: its instances share a global rule store. Its declared `legacyDisableLayers` option is not forwarded to the native rule processor; disabling layers still adds priority selectors. The experiment calls the native processor directly with both `useLayers: false` and `legacyDisableLayers: true`. It does not transform selectors or increase specificity. Babel's default import-source handling also requires explicit isolation rather than assuming a custom source excludes ordinary StyleX imports.

## Bounded trial and the ordering rejection

The frozen171/180 patch is eleven files/348 changed lines for nine defaults and
seven distinct atoms in AdaptiveTabStrip. It gives every client mode a private
CSS file and changes only the quoted path in one owned CSS import; ordinary
rules, layers and position remain untouched. Binding-aware static compilation
folds all four calls and removes the unused real typed re-export. Canonical load
guards reject runtime escapes. Compiler dependencies are direct, pinned versions;
the lock changes only three importer entries with no new package resolutions.
Vitest has an explicit transform-only route, not App SSR. Development updates of
this owner intentionally reload the page; a private lifetime atom history retains
old in-flight JS readers. Ordinary StyleX HMR retains its own state. Concurrent
client output, optimizer reuse, source TSX maps and ordinary HMR have real checks;
the original 164 failure remains preserved.

Final renderer-only and Storybook builds pass with 4,589 fixed inputs. Actual
onboarding summary uses the real TourApp/SessionTabBar, but its static camera is
partially clipped, pointer-inert and light-themed; it is not session interaction
or dark-App coverage. Under natural finite-animation readiness, 180's visible
native row has zero differing pixels and full captured geometry matches, while
the whole App retains 39 raw/zero-threshold pixels OPEN. Static camera opacity
stays its designed 0.48; no animation was paused or forced. Earlier 171/177 OPENs
and a restoration-before-exit harness mistake remain distinct. The corrected run
quits all owned App processes before restoring all 1,222 renderer files; 335
main/CLI/lock guards match. Components types and seven owning tests pass. The final frozen171 replay passes all 54 Storybook and twelve standalone pairs,
including 46 unchanged ordinary controls; Root independently reopens all full
pre/post Brotli records and decodes PNGs (3,022 scene records, 720 exact class
carriers). Raw class strings differ, including three direct same-property caller
cases, despite matching rendering. Complete Electron node/web types pass in the
frozen mirror without CLI prerequisites. These subset results earn zero production migration credit.

The initial factory also missed Windows-normalized module IDs. A minimal
`normalizePath` correction passes real compiler/Vite-function Win/POSIX tests in a
virtual filesystem; actual macOS consumer JS/CSS bytes match. This is not a
Windows OS run. A retained three-case compiler test uses explicit pending-read
signals, not scheduler timing. The historical patch and original matrices remain
unchanged.

The current-input trial184 applied thirteen paths, compiled both official
renderers (9,087 modules each), and preserved all 3,946 ordinary and 2,864 unlayered
rules. Its real App native crop has zero differing pixels; the whole viewport
retains 312 raw/zero-threshold pixels OPEN. Four class carriers, 46 boot-variable
values, one HTML boot style and two linked panel IDs are explicit differences.
This does not establish whole-page field or animation-history equivalence.

Trial188 then renders the real Adaptive component with the same literal caller
fixture in two complete builds. `[width:0px]` changes strip width598→16px,
`[min-width:840px]` changes viewport598→840px, and `[overflow:visible]` changes
item clipping and the real hit-test chain. Default and three named utility
controls match. `twMerge` retains the named defaults beside arbitrary properties;
Tailwind originally sorts those arbitrary-property rules before the named
utility. Putting every native atom before Tailwind reverses that outcome.
No CSS patch or default-only success can accept these counterexamples.

Root restored all thirteen trial paths to their original bytes and removed the
six newly added files. The compiler/dependency/lock route is not adopted; the nine
Adaptive defaults remain Tailwind. `leaves188-counterexample.html` owns the real
captures and `root188-native-rejection-restoration-proof.json` the exact rollback.
All171/177/180/184 successes, OPENs and failures remain historical evidence.

## Proposed next boundary

Evaluate a small extraction route only for an explicitly identified native default whose complete caller and state contract is demonstrated. Give that route distinct compiler identities and atom prefixes, preserve the ordinary route, and test the actual final CSS order. Keep public raw selectors, Slot behavior and state/query utilities on their existing paths until their separate ordering contracts have an equivalent replacement.

Before integrating a build change, demonstrate that the real application, Storybook and standalone output share that boundary; audit collisions, variables, registrations and every retained rule. Repeat named and arbitrary-property callers, variants, shorthand interactions and normal StyleX controls. A default screenshot, an empty caller guard, or thirteen passing native cases cannot approve arbitrary public Slot migration. No global extraction order has been selected, and no compatibility API has been retired.
