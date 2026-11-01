# A bounded StyleX extraction route for legacy cascade contracts

Status: proposed
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[中文](2026-10-31-stylex-cascade-compatibility.zh.md)

## Abstract

Moving public Tailwind defaults across CSS layers or changing their class identities can alter supported caller precedence. The early flat-utilities trial was restored after three arbitrary-property counterexamples, and exact-position hash aliases still break named `cn` controls. A smaller CSS-only experiment preserves twelve controls by replacing the original declarations with real StyleX metadata while keeping selectors, class strings and rule positions unchanged. This is a proposed declaration-ownership bridge that still requires Tailwind candidate ordering and explicit bindings. No production compiler, dependency or public compatibility API has changed, and these experiments receive zero migration credit.

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

## Declaration ownership with compatibility selectors

`root-native-default-boundary-research.json` records the locked-version follow-up.
Placing independent hashed atoms beside their original Tailwind rules repairs the
previous arbitrary-property and zero-specificity cases, but three real named
controls fail: `w-0` changes width0→400px, `opacity-50` changes0.5→0.7, and `block`
changes to flex with a different hit chain. The current `cn` cannot identify the
new hash as the original utility group. Registering three explicit groups through
`extendTailwindMerge` repairs those synthetic controls, but introduces another
registry and does not preserve exported raw class strings. CSS position alone is
therefore insufficient; sharing ordinary atom identities also remains unsafe.

A separate two-binding experiment keeps the old `.opacity-70` and `.w-full`
selectors and class values. It detaches the original declaration nodes and inserts
the actual StyleX metadata declarations at the same rule positions and contexts;
there is no second effective Tailwind body masking the new declarations. The full
CSS remains byte-identical. Two compiled `stylex.props` bindings are explicitly
mapped back to their legacy class values, so real `twMerge` behavior is retained.
Chrome verifies twelve static controls, including zero-specificity opacity0.7,
normal descendant opacity1, named width0 and arbitrary width400px. A separately
recompiled opacity0.6 declaration is rejected by the strict equivalence oracle.

This proves only a small declaration-ownership boundary. It still needs Tailwind
to retain and order candidates, explicit metadata-to-selector/context and class
bindings, and a custom build transform. It is not an existing StyleX option or a
completed product migration. That two-binding probe did not verify dynamic values, variants, Slot composition,
production consumers, development updates or complete source maps. The bounded
206 follow-up below qualifies one static opacity binding only. The probe changes no product, configuration, dependency or lockfile;
its real browser checks produce no application screenshots. The exact compile,
binding and browser records live under `root-native-exact-slot-probe/`.

## One actual owner through production and development

The isolated206 follow-up targets the existing `opacity-70` caller in
`MobileInlinePicker`; the legacy Spinner itself has no such default. One separate
StyleX module owns the static declaration. Its folded binding keeps the original
class string, and the bridge detaches Tailwind's declaration before inserting a
clone of the real compiler metadata at the same selector, layer and rule slot.
Ordinary StyleX collection remains separate. This is declaration ownership with a
compatibility selector, not removal of the Tailwind candidate-ordering dependency.

Seven production pairs from the original prototype match complete recorded raw
objects and PNG/RGBA bytes; two real development pairs from the corrected version
match outside80 explicit debug-source line attributes. Together they cover505
nodes and nine exact images. Development emits `70%`, whereas production emits
`.7`: the first strict numeric oracle rejected the percentage. The corrected
oracle accepts only bounded static numbers or percentages and compares their
exact numerical values. Its actual production build preserves all106 CSS files
and the binding's74 JavaScript bytes; the seven production screenshots were not
recaptured with that correction. Real binding tests pass before and after, and
the corrected source passes component types. `leaves206-delivery.json` and
`leaves206-acceptance.html` retain the source banks, nine original pairs and three
initial failures under the visual artifact directory.

Recompiling the declaration as`.6` is rejected by the production-CSS transform
oracle and a real Vite update. The negative does not run a complete production build. The update produces `vite:error` and a CSS404 response, but Chromium
retains the last successful`.7` stylesheet with no error overlay. This rejects
publication of unequal CSS; it does not prove the whole page fails closed. The
original stronger producer label is retained and explicitly qualified rather
than silently rewritten.

This hard-coded experiment is not a production-ready compiler facility. It uses
transitive compiler resolution and an experiment-only proof directory; public
configuration, direct pinned dependencies, general binding ownership, complete
source-map composition and an actual paired Electron run still need review.
Dynamic values, other properties, variants and Slot composition remain unproved.
All four owned development process groups exited, Root product/configuration/lock
bytes stayed unchanged, and production migration credit remains zero.

## Proposed next boundary

Evaluate the selector-preserving bridge on one bounded owner before widening it.
Keep its real StyleX declarations beside that owner, preserve the original `cn`
inputs and public class contract, and reject missing or unequal declaration and
context mappings. Retaining an effective Tailwind declaration underneath an
unused StyleX class is not a migration. Record compatibility selector bindings
separately from ordinary StyleX atoms and source-utility removal counts.

Before production integration, demonstrate the actual application, Storybook and
test pipelines, named and arbitrary-property callers, normal and zero-specificity
ancestors, shorthand and variable behavior, Slot cases and ordinary StyleX
controls. Check final optimized output rather than an intermediate stylesheet;
selector-list optimization and stale development responses must not invalidate
the contract. No global layer/order change is selected, no public compatibility
API is retired, and the rejected thirteen-path trial remains restored.
