# A bounded StyleX extraction route for legacy cascade contracts

Status: proposed
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[中文](2026-10-31-stylex-cascade-compatibility.zh.md)

## Abstract

Moving a public component's Tailwind defaults into the earlier StyleX layer can change which caller styles win, even when default screenshots match. An isolated experiment preserves thirteen AdaptiveTabStrip cases by extracting a separate StyleX namespace into the utilities layer before Tailwind. It also demonstrates real Slot and source-order failures, so this is a possible route for selected native defaults, not a general replacement or an adopted build change. Product sources, configuration, dependencies and lockfiles remain unchanged by the experiment.

## Evidence and limits

The [migration note](../../implemented/architecture/2026-10-22-tailwind-to-stylex-migration.md) owns completed migration and its inventory. Local evidence is `packages/components/artifacts/visual/leaves156-acceptance.html`, with the original captures, failures and an embedded reproducible experiment. These are real browser results from isolated source and compiler inputs; they earn no product migration credit.

| Experiment                                                                                                    | Observed result                                                                                                  | Limit                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native `utilities.priorityN` sublayers                                                                        | All nine zero-specificity ancestor cases change                                                                  | Unlayered rules inside `utilities` still outrank its sublayers.                                                                                                     |
| Separate import namespace and class prefix; native metadata extraction into flat `utilities`, before Tailwind | All thirteen Adaptive cases match complete recorded fields and PNGs; the ordinary StyleX control stays unchanged | Radix Slot grid-parent/flex-child changes grid to flex and height 55 to 28px.                                                                                       |
| The same extraction placed after Tailwind                                                                     | Repairs that Slot direction                                                                                      | Breaks the reverse Slot direction, direct caller width 840 to 0, and the retained 366px query's active minimum 180 to 0; none of the thirteen Adaptive cases match. |
| Reusing ordinary atom names across the two routes                                                             | Adaptive cases match                                                                                             | Promotes a shared atom into `utilities`; an ordinary StyleX control changes overflow from visible to hidden despite identical pixels.                               |

The original five direct-caller frames omitted `items-end` from the fixture's Tailwind candidate list. They remain rejected evidence. Only those five cells were corrected and captured again after proving the stylesheet changed solely by the missing rule; sixty healthy cells were retained.

The installed 0.19 unplugin cannot be treated as two isolated collectors: its instances share a global rule store. Its declared `legacyDisableLayers` option is not forwarded to the native rule processor; disabling layers still adds priority selectors. The experiment calls the native processor directly with both `useLayers: false` and `legacyDisableLayers: true`. It does not transform selectors or increase specificity. Babel's default import-source handling also requires explicit isolation rather than assuming a custom source excludes ordinary StyleX imports.

## Proposed next boundary

Evaluate a small extraction route only for an explicitly identified native default whose complete caller and state contract is demonstrated. Give that route distinct compiler identities and atom prefixes, preserve the ordinary route, and test the actual final CSS order. Keep public raw selectors, Slot behavior and state/query utilities on their existing paths until their separate ordering contracts have an equivalent replacement.

Before integrating a build change, demonstrate that the real application, Storybook and standalone output share that boundary; audit collisions, variables, registrations and every retained rule. Repeat the real caller regressions and normal StyleX controls. A default screenshot, an empty caller guard, or thirteen passing native cases cannot approve arbitrary public Slot migration. No global extraction order has been selected, and no compatibility API has been retired.
