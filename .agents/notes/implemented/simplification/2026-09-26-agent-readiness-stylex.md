# Move the provider readiness mark to StyleX without visual change

Status: implemented
Translation: current

[中文](2026-09-26-agent-readiness-stylex.zh.md)

## Abstract

The provider readiness mark still used Tailwind utilities and a global CSS orbit
after the business layer adopted StyleX. Its styling now lives beside the
component in StyleX, while the states, sizes, and HTML animation wrapper remain
the same. The component exposes an avatar surface for the onboarding caller.
Six Storybook scenes across light and dark themes had zero changed pixels
with the animation phase fixed. The
product's `--muted` wash remains a local colour bridge because the shared token
set has no exact counterpart.

## Decision

`AgentReadinessMark` composes StyleX size and state rules with the existing
`@lody/ui` label, secondary label, accent, separator, and radius tokens. The
40% `--muted` background mix is retained verbatim to preserve the existing
theme surface; replacing it with a nearby shared token changed the contract of
this appearance-only migration. A matching semantic token can replace that
bridge when the product palette defines one.

The onboarding row still passes `rounded-full bg-muted/50` through `className`
in this first stack layer. The new `surface="avatar"` prop can select those two
rules inside the mark when that caller is migrated in the follow-up layer. The
default tile keeps the 40% wash. External `className` remains available for
caller layout.

The orbit keyframes moved from `tailwind/index.css` into the component. The
indeterminate SVG still sits inside an animated HTML span, preserving the Retina
compositing constraint explained in the
[spinner decision](../bug-fix/2026-09-13-spinner-off-svg-retina-composite.md).
The caller's optional `className` still applies to the outer mark for layout.

## Verification

An isolated checkout at the same commit supplied Storybook dependencies; the
active worktree did not install them. Chromium rendered the `Vocabulary`,
`InventoryFillingIn`, and `Sizes` stories at 640 × 500 in light and dark
themes before and after the migration. Fonts were loaded, the viewport and
theme were fixed, and the indeterminate orbit was set to its zero phase in
both revisions. All six PNG comparisons had zero changed pixels. The component typecheck and
StyleX development transform passed. Chromium also reported a 1.4 s linear,
infinite transform animation on the 40 px HTML wrapper, and `animation-name:
none` under reduced motion. The comparison covers these rendered states, not
every host theme or device scale factor.
