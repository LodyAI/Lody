# Keep shared visual cues local to StyleX

Status: implemented
Translation: current
PR: [#1012](https://github.com/LodyAI/Lody/pull/1012)

[中文](2026-09-26-shared-cues-stylex.zh.md)

## Abstract

The conversation drop mask, DeepSeek delegation warning, and MCP transport glyph
were small shared components whose appearance still came from Tailwind. Their
visual rules now live in each component's StyleX definition while their roles,
text, and caller interfaces remain unchanged. The drop mask retains its
theme-specific translucency without following the operating system's theme.
Twelve fixed Playwright scenes in the supported light and dark themes had zero
changed pixels.

## Decision

These cues have separate owners rather than a shared visual helper: the drop
mask is a page-level status overlay, the warning is linked run-config copy, and
the transport glyph belongs to MCP settings. Each therefore keeps a small
component-local `stylex.create` definition. Colours use the product-mapped
`@lody/ui` accent, label, background, and warning tokens.

The drop mask's 55%/12% light and 45%/16% dark accent films are visual
constants, not a new palette role. The StyleX selectors follow the app's
explicit `.dark` class; a media-query choice would be wrong when the user
selects a theme independently of the OS. Its 16px dashed frame radius and
small shadow stay at their existing values because no shared token is
pixel-equivalent. The overlay remains pointer-transparent: the parent drop
zone owns hit testing.

## Verification

Playwright rendered isolated mention/file masks, the real chat landing mask,
the desktop-layout delegation warning, and stdio/HTTP MCP forms at 800 × 760
in both themes. The original Tailwind revision and the StyleX revision used
the same Storybook fixture, viewport, font loading, reduced-motion setting, and
hidden input caret. All twelve before/after PNG pairs had zero changed pixels.
Chromium also reported the same dark-mask border and fill when the app theme
was dark under either light or dark OS preference. `@lody/components`
typechecking passed. This covers the sampled host surfaces and themes, not
every device scale factor or custom theme.
