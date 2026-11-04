# Neutral grays in Lody Light

Status: implemented
Translation: current

[中文](2026-10-17-neutral-light-grays.zh.md)

## Abstract

Lody Light mixed blue-tinted grays into sidebar fills, text, dividers, subtle shadows and the shared light gray ramp, while the page and raised surfaces were already neutral. The similar brightness but different hue made adjacent areas feel inconsistent. Neutral grayscale roles now have zero saturation at their existing HSL lightness across the bundled theme, UI palette and CSS fallbacks; the blue accent and Vesper's dark palette keep their intended colors. The change is source-checked, but has not had a rendered visual review.

## Finding

The bundled `lody-light.json` supplied the active sidebar and workbench colors. Its sidebar was `#EFEFF1`, hover `#E0E0E4`, selection `#DCDBE1`, border `#C9CDD6` and foreground `#1A1B1E`. The light package palette and unthemed Tailwind fallbacks also used blue-gray HSL values. The first-frame boot shell copied separate HSL values, so changing the resolved theme alone would leave the initial sidebar and status text tinted.

## Decision

Remove chroma from neutral light-theme colors while keeping their HSL lightness. This keeps the existing visual hierarchy and selected-row depth while making the grays read as one neutral family. For example, the bundled values become `#F0F0F0`, `#E2E2E2`, `#DEDEDE`, `#D0D0D0` and `#1C1C1C` respectively.

Apply the same rule to the `@lody/ui` light palette, its gray ramp and shadow ink, the Tailwind light fallbacks (including the task surface), and the boot shell. Preserve blue links and primary actions, syntax and selection colors that communicate a blue state, and Vesper's dark palette. This keeps Lody's accent and dark appearance intact instead of adopting another product's full palette.

## Evidence

- The active light theme maps `sideBar.background`, list hover and selection colors, sidebar borders and foregrounds into the app's CSS tokens in `lib/vscode-theme/vscode-theme-css.ts`.
- `lody-ui-palette.stylex.ts` applies the light semantic palette; the shared gray ramp is defined in `packages/ui/src/tokens/colors.stylex.ts`.
- `BOOT_SHELL_COLORS.light` supplies the pre-render sidebar, border and status colors and is expected to match the bundled theme.
- The intentional blue editor stack-frame highlight remains blue; chromatic syntax and action colors were not treated as gray.

## Verification and limits

`tests/boot-shell.test.tsx` checks that the literal first-paint canvas, sidebar, sidebar border and status colors match the bundled theme's resolved values. The focused boot-shell, sidebar badge and workspace sidebar suites pass. The theme's rendered appearance and contrast still need visual review in the app.
