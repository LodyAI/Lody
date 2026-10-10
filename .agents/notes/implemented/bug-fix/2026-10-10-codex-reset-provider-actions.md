# Keep Codex reset forecasts clear of provider actions

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1407

[中文版](2026-10-10-codex-reset-provider-actions.zh.md)

## Abstract

The compact provider row placed refresh and delete actions over its trailing content on hover or keyboard focus. When a Codex row had no inline rate-limit meters, that overlay covered the reset forecast button, hiding its label and part of its icon. The forecast now keeps its normal trailing position, and hover actions appear immediately before the protected trailing content. Hidden actions occupy no layout space, so the resting row has no empty button slots and the forecast does not move when actions appear. Actions can temporarily cover passive provider text, consistent with the existing compact-row interaction.

## Cause and decision

`ProviderRow`'s `reveal` style combined absolute positioning, an opaque hover fill, and visibility. `CodexResetForecastChip` occupied the same end of the row. This is a shared layout defect rather than a Windows-specific rendering rule.

Separate visibility from overlay positioning. For compact rows with a forecast entry, the trailing cluster is a positioning anchor and the action overlay ends immediately before it. This protects the forecast and any inline meters without pushing the forecast away from the normal trailing inset. Other compact rows keep their existing end overlay. During a refresh, actions remain visible at the same anchored position.

An initial fix reserved normal-flow space for hidden actions. It prevented overlap but left an empty refresh/delete area at rest, so it was replaced within this PR. The final layout preserves the forecast's position across hover and keyboard focus without that permanent reservation. Eligibility, interaction-only loading, and dialog ownership remain with the existing entry component.

This is a local correction to the [settings record layout](../feature/2026-09-26-settings-row-grammar.md), not a change to reset semantics or provider eligibility.

## Verification

Storybook fixtures cover active forecasts at wide and narrow widths, plus an empty forecast row without rate-limit meters. Six English/Chinese Chromium cases pass: actions are hidden at rest, a row without meters has no empty action slots after its forecast, the forecast stays fixed on hover, revealed actions do not overlap it, and the dialog opens by mouse and keyboard. The original layout reproduced a 60px overlap with the refresh button. Playwright screenshots also inspect the final resting and hovered states.

The existing provider and forecast unit suites pass (85 tests), as do the components package typecheck and changed-file lint/format checks. Full `pnpm check` is blocked by uninitialized ACP adapter submodules during CLI typechecking. Packaged Windows Electron verification remains outside this environment.
