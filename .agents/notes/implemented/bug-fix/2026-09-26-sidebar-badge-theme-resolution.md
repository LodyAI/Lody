# Resolve the sidebar badge theme inside its token module

Status: implemented
Translation: current

[中文](2026-09-26-sidebar-badge-theme-resolution.zh.md)

## Abstract

The sidebar's Mergeable badge could stop the StyleX development transform with
"Only static values are allowed inside of a createTheme() call," even after
both override values became literals. StyleX evaluates the variable group before
the overrides, making the cross-package `badge` reference the remaining likely
failure point. The prominent success theme now lives beside `badge` in `@lody/ui`; the
sidebar re-exports it without compiling another `createTheme` call. Its success
word and 16% film retain the [reading-contrast decision](../feature/2026-09-24-reading-contrast.md).

## Decision and evidence

`@lody/ui` owns the badge token group and already creates its palette theme in
the same source module. The product's local file now names the opt-in theme for
the Mergeable row, while the group and its override are compiled together. The
UI gallery shows the prominent success state alongside the ordinary tones.

The installed StyleX Babel plugin evaluates the first `createTheme` argument
before its override object and reports the same static-value error if either
evaluation is uncertain. The successive failures with a static fill and then
with two literal values rule out those expressions as the sole cause. A relative
source import would retain a cross-package `createTheme` call at the failure site;
moving the theme removes that dependency from the sidebar transform.

## Verification and limit

The Electron renderer production build compiled the new theme, including its
16% success film. In the Storybook token board, the rendered badge had a 16%
fill and success-coloured text in both palettes (light `rgb(41, 142, 93)`, dark
`rgb(59, 206, 135)`). UI and components typechecks, the UI gallery and sidebar
badge tests, and the public-boundary check passed. Electron itself is not
installed in this checkout, so a full interactive desktop session was not run.
