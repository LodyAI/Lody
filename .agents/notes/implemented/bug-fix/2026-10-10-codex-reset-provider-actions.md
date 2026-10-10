# Keep Codex reset forecasts clear of provider actions

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1407

[中文版](2026-10-10-codex-reset-provider-actions.zh.md)

## Abstract

The compact provider row placed refresh and delete actions over its trailing content on hover or keyboard focus. When a Codex row had no inline rate-limit meters, that overlay covered the reset forecast button, hiding its label and part of its icon. Rows with a forecast entry now reserve space for the actions in the flex layout while retaining their hover and focus visibility. This costs some provider-name space at rest, but keeps the forecast readable and independently clickable.

## Cause and decision

`ProviderRow`'s `reveal` style combined absolute positioning, an opaque hover fill, and visibility. `CodexResetForecastChip` occupied the same end of the row without reserving the overlay's width. This is a shared layout defect rather than a Windows-specific rendering rule.

Separate visibility from overlay positioning. Compact rows with a forecast entry keep actions in normal flow even while invisible; other compact rows retain their overlay. The provider name and metadata already support truncation, so they yield space before controls do. The forecast's eligibility, interaction-only loading, and dialog ownership remain with the existing entry component.

This is a local correction to the [settings record layout](../feature/2026-09-26-settings-row-grammar.md), not a change to reset semantics or provider eligibility.

## Verification

Storybook fixtures cover active forecasts at wide and narrow widths, plus an empty forecast row without rate-limit meters. The desktop settings browser suite checks actual control bounds, hit targets, and opening the forecast dialog by mouse and keyboard in English and Chinese. The existing provider and forecast unit suites pass (85 tests), and the components package typecheck and changed-file lint/format checks pass. All six browser cases pass using an already installed Chromium executable. Restoring the old overlay makes the no-meter regression fail with a 60px overlap between the forecast and refresh buttons. Packaged Windows Electron verification remains outside this environment.
