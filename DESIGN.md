# Lody Design System & UI Guidelines

This document defines Lody's core visual standards and non-negotiable UI bans across desktop, web, and shared component packages. All UI work—by humans and coding agents alike—must follow these rules alongside [`packages/ui/src/tokens/RULES.md`](packages/ui/src/tokens/RULES.md) and [`packages/ui/AGENTS.md`](packages/ui/AGENTS.md).

## 1. Visual Philosophy

- **Neutral monochrome first (Linear / Raycast craft)**: Surfaces, typography, controls, and focus states are fundamentally neutral. Light mode (`Lody Light`) uses zero-saturation neutrals; dark mode (`Vesper`) uses deep neutral charcoal steps.
- **Depth without borders**: Do not draw arbitrary `1px` gray borders around boxes. Separate surfaces using `@lody/ui` elevation rungs (`well`, `page`, `region`, `card`, `floating`, `modal`) and hairline shadows. Use `Separator` strictly between sibling rows or bands.
- **Semantic color is earned**: Reserve `accent`, `success`, `warning`, and `destructive` for real meaning—links, stored on/checked states, active running indicators, status outcomes, and destructive actions. Never use saturated accent fills on primary buttons (primary buttons use `label` ink fill with `background` text) or decorative chrome.

## 2. Focus & Input Styling (Strict Rules)

- **Banned — Saturated blue outlines / thick `2px` accent rings on inputs**:
  - Never style text inputs, search bars, textareas, selects, comboboxes, or standard form fields with browser-default blue `outline`, Tailwind `ring-blue-*`, or a thick `2px` solid `colors.accent` focus ring.
  - Never add soft colored outer glows/halos around focused inputs.
- **Required — Crisp `1px` neutral focus edge for fields**:
  - All controls in the `@lody/ui` `field` family use `field.ringWidth: 1px` with a neutral `field.ring` (`color-mix(in oklab, colors.label 34%, transparent)`), composed into `box-shadow` tight to the control with zero offset and zero blur.
  - Invalid fields use `1px` `field.invalidRing` (`colors.destructive`) at rest and while focused.
- **Required — Modality-aware focus for non-field controls**:
  - Buttons, toggles, tabs, and interactive rows read `focus.ringWidth`, which `installFocusModality` zeroes during pointer interaction so clicking a button does not leave a lingering ring. Keyboard navigation keeps a clear focus indicator.

## 3. Structural Anti-Patterns (Banned)

- **No card-in-card nesting**: Never place a bordered or shaded card inside another card. Group related subsections inside a single card using `separator` hairlines and consistent vertical rhythm, or use the `region` rung where a recessed band is required.
- **No forced section headings for a single row**: Do not wrap a single standalone action or setting row in a titled section card just to match visual symmetry.
- **No redundant count badges or decorative chrome**: Avoid piling `(3)` count pills onto filter tabs, or wrapping simple lists in heavy gray accordion headers when a clean flat or tabular card works.
- **No one-off styles outside the design system**: Use `@lody/ui` primitives, semantic tokens, and existing layout helpers (`surface.ts`, `compact-layout.tsx`). Avoid hardcoded hex/rgb values, native `<input type="search">` blue cancel buttons, or absolute-positioned icon hacks when `Input`'s `leading`/`trailing` slots exist.

## 4. Verification Standard

Before considering any UI change complete, verify the rendered result in both **Light** and **Dark** themes across key states: default, focused input, empty/no-results, offline/disabled, read-only/shared, and narrow/compact viewports where applicable.
