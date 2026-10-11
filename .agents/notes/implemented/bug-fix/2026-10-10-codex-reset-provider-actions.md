# Separate Provider quota, forecasts, and management

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1407

[中文版](2026-10-10-codex-reset-provider-actions.zh.md)

## Abstract

The compact Provider row mixed remaining quota, third-party reset probability, and Provider operations in one trailing cluster. Its hover overlay could hide the forecast, while positional fixes still grouped unrelated percentages and actions. The final row presents identity, explicitly labeled read-only remaining quota, a flat direct forecast action, and a named Provider management menu. Forecast probability appears only in the existing forecast dialog. Opening the forecast takes one action, with no intermediate quota popover repeating visible data.

## Decision

The original layout reproduced a 60px overlap between forecast and refresh controls. Intermediate fixes reserved empty action slots or shifted operations beside the forecast. A quota-details interstitial then repeated already visible 5h/7d data and added a second step to the forecast; it is removed within this PR. The final hierarchy is recorded in the [Provider quota overview draft](../../../../specs/provider-quota-overview.md).

`ProviderRow` owns identity, exact per-configuration quota selection, and the named management menu. Its container grid keeps quota beside the identity when space allows and below it otherwise. Refresh and delete preserve their operations and confirmation. Their compact popup has two action rows separated before Delete, without a duplicate Provider heading; the trigger retains the Provider's accessible name. `ProviderUsageSummary` displays every reported window with remaining-quota semantics, wrapping additional windows rather than hiding them. Its separate flat “Reset forecast” action directly opens the existing dialog; its label contains no probability.

Eligible Codex rows retain that direct action when usage or an active forecast is absent. Listing rows does not request forecast data; the action uses the existing shared store when opening the dialog. The dialog explains the third-party source and returns focus to its stable entry when closed. Composer forecast behavior is unchanged.

Quota text uses the mini button's footnote size and unit line height. The overview, quota group, and individual meters align text by baseline; only graphical tracks center themselves. Chromium measured an approximately 1px text-baseline offset with the former 11px quota text and centered layout, and identical baselines after this correction.

## Verification and limits

- 92 tests across Provider row, machine detail, and forecast suites pass. A real-store integration test observes idle state on listing and loaded state only after selecting the direct forecast action.
- Eight English/Chinese Chromium cases cover direct opening by mouse and keyboard, no intermediate quota UI, wide/narrow panels, missing quota, probability confined to the dialog, shared text baselines, focus return, refresh results, and delete confirmation. A three-window Claude fixture verifies every meter remains visible and inside a narrow row.
- Playwright screenshots inspect the final wide/narrow rows with synthetic quota data and the direct forecast dialog.
- Full `pnpm check` remains limited by uninitialized ACP adapter submodules during CLI typechecking. Packaged Windows Electron verification is outstanding.
