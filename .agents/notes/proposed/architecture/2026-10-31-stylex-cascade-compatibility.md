# A bounded StyleX extraction route for legacy cascade contracts

Status: proposed
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[中文](2026-10-31-stylex-cascade-compatibility.zh.md)

## Abstract

Moving public Tailwind defaults into the earlier StyleX layer can change which caller styles win, even when default screenshots match. A separate namespace extracted into utilities before Tailwind preserves 66 real AdaptiveTabStrip pairs in two isolated client builds, including ordinary StyleX controls. Real Slot and source-order counterexamples still prevent a general replacement; development, hot updates and the actual App renderer remain unverified. This is a proposed route for selected native defaults, with no production configuration, dependency or lockfile change.

## Evidence and limits

The [migration note](../../implemented/architecture/2026-10-22-tailwind-to-stylex-migration.md) owns completed migration and its inventory. Local evidence is `packages/components/artifacts/visual/leaves156-acceptance.html`, with the original captures, failures and an embedded reproducible experiment. These are real browser results from isolated source and compiler inputs; they earn no product migration credit.

| Experiment                                                                                                    | Observed result                                                                                                  | Limit                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native `utilities.priorityN` sublayers                                                                        | All nine zero-specificity ancestor cases change                                                                  | Unlayered rules inside `utilities` still outrank its sublayers.                                                                                                     |
| Separate import namespace and class prefix; native metadata extraction into flat `utilities`, before Tailwind | All thirteen Adaptive cases match complete recorded fields and PNGs; the ordinary StyleX control stays unchanged | Radix Slot grid-parent/flex-child changes grid to flex and height 55 to 28px.                                                                                       |
| The same extraction placed after Tailwind                                                                     | Repairs that Slot direction                                                                                      | Breaks the reverse Slot direction, direct caller width 840 to 0, and the retained 366px query's active minimum 180 to 0; none of the thirteen Adaptive cases match. |
| Reusing ordinary atom names across the two routes                                                             | Adaptive cases match                                                                                             | Promotes a shared atom into `utilities`; an ordinary StyleX control changes overflow from visible to hidden despite identical pixels.                               |

The bounded client-build prototype uses a private 96-line extractor for one fixed
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

The extractor must run before React/docgen source transforms; its strict raw-source
equality rejected the original later wiring. Its seven constant atoms fold every
StyleX call, so no dynamic runtime alias was exercised. It deliberately rejects
dev/HMR, build-watch and SSR; its generated file and private compile cache do not
yet establish safe ownership across concurrent development servers. Source maps,
directly declared compiler dependencies and an actual paired Electron renderer
run remain adoption requirements. The second client build is a standalone
consumer, not the Electron App. The existing renderer-only verification path can
hold main/CLI bytes fixed without invoking ACP prerequisites.

The original five direct-caller frames omitted `items-end` from the fixture's Tailwind candidate list. They remain rejected evidence. Only those five cells were corrected and captured again after proving the stylesheet changed solely by the missing rule; sixty healthy cells were retained.

The installed 0.19 unplugin cannot be treated as two isolated collectors: its instances share a global rule store. Its declared `legacyDisableLayers` option is not forwarded to the native rule processor; disabling layers still adds priority selectors. The experiment calls the native processor directly with both `useLayers: false` and `legacyDisableLayers: true`. It does not transform selectors or increase specificity. Babel's default import-source handling also requires explicit isolation rather than assuming a custom source excludes ordinary StyleX imports.

## Proposed next boundary

Evaluate a small extraction route only for an explicitly identified native default whose complete caller and state contract is demonstrated. Give that route distinct compiler identities and atom prefixes, preserve the ordinary route, and test the actual final CSS order. Keep public raw selectors, Slot behavior and state/query utilities on their existing paths until their separate ordering contracts have an equivalent replacement.

Before integrating a build change, demonstrate that the real application, Storybook and standalone output share that boundary; audit collisions, variables, registrations and every retained rule. Repeat the real caller regressions and normal StyleX controls. A default screenshot, an empty caller guard, or thirteen passing native cases cannot approve arbitrary public Slot migration. No global extraction order has been selected, and no compatibility API has been retired.
