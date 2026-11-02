# A closed StyleX font writer pair

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[中文](2026-11-03-stylex-font-writer-pair.zh.md)

## Abstract

Migrating a font weight without its private writer changes the supported CSS contract. The declaration bridge now accepts one closed `font-medium` pair, inserting both native StyleX declarations into their original rule while preserving class identity, order and registration. One actual ACP selector label passes 24 paired browser states and six build paths. The pair retains Tailwind aliases and ordering; combined Root qualification and all historical visual differences remain separate from that isolated acceptance.

## Boundary

The [implemented bridge](2026-10-31-stylex-cascade-compatibility.md) remains the owner of compilation, producer phases and public precedence. Only the following literal pair is supported:

```css
.font-medium {
  --tw-font-weight: var(--font-weight-medium);
  font-weight: var(--font-weight-medium);
}
```

Both right-hand sides remain the same element-local variable reference. Preserve the writer-first order, original selector, utilities layer, physical slot and `@property --tw-font-weight` registration. Fold the two native atoms back to the original alias once. Do not route them through the ordinary collector, rename the private property, omit the writer, infer atom identity from metadata order, or widen this into variants or an arbitrary rule language.

The native compiler emits a writer atom at priority 1 and a weight atom at priority 3000. A property-to-atom bijection can associate them without relying on that order. Production extraction must reject missing, duplicate, unequal or unexpected fields and validate every replacement before changing CSS. Keep existing single-field declarations and compiled bindings unchanged.

## Evidence and acceptance

Local evidence lives in `packages/components/artifacts/visual/`.

| Evidence                                      | Result                                                                                                                                                                                                | Limit                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `review-font-medium-feasibility-opinion.json` | Original-order donor cloning preserves complete CSS bytes in six real or locked optimization phases.                                                                                                  | A feasibility probe, not a production adapter implementation.                                |
| Native prefix checks                          | The recorded 58 keys and 80 exports remain unchanged.                                                                                                                                                 | Later Root additions require their own prefix check.                                         |
| Real Chrome contract                          | 24 root/local/CSS-wide DOM cases are captured in three real Chrome images (original, paired, writer-omission negative); the positive screenshot agrees and the negative changes 46 observable fields. | Synthetic CSS contract, not product UI coverage or hardware validation.                      |
| Production implementation                     | 56 real compiler tests cover the closed pair, including actual raw and optimized rules, both author maps and rejected mutations.                                                                      | Other multi-declaration rules remain unsupported.                                            |
| Actual ACP label                              | All 24 real product PNG pairs match; 3,969 body and 255 target records match outside 48 precise URL carriers. Six actual build paths preserve 108 CSS pairs.                                          | Isolated candidate; combined Root69-key/70-declaration/89-binding qualification is separate. |

`leaves240-delivery.json`, `leaves240-acceptance.html` and
`review240-final-independent-verification.json` own the product evidence and
independent review. The 24 product pairs are distinct from the research's 24 DOM
cases in three images. Public callers, local/CSS-wide variables and the original
writer reader are covered; native operating-system behavior is not established.
The report's original asynchronous close failure and its repaired viewer remain
recorded. No previous visual OPEN is closed by these passing states.

Count style keys, physical declarations, bindings and retained utility positions
separately: one pair has one style key and two physical declarations. This
adoption migrates one ownership position with zero net dependency removal.
