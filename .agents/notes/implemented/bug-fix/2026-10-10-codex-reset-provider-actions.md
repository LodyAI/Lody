# Separate Provider quota, forecasts, and management

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1407

[中文版](2026-10-10-codex-reset-provider-actions.zh.md)

## Abstract

The compact Provider row mixed remaining quota, third-party reset probability, and Provider operations in one trailing cluster. Its hover overlay could hide the forecast, and positional fixes still left unrelated percentages and actions visually grouped. The row now presents identity, explicitly labeled remaining quota, and a persistent Provider management menu; reset forecasts are reached through quota details. The forecast remains available when usage is unknown, but takes one additional step to open. This gives each percentage and action a clear subject without hover overlays or empty action slots.

## Decision

The original layout reproduced a 60px overlap between forecast and refresh controls. Reserving hidden action slots introduced a permanent empty area; moving hover actions before the forecast avoided overlap but grouped Provider actions with forecast probabilities. Those intermediate implementations are superseded within this PR by the hierarchy in the [Provider quota display draft](../../../../specs/provider-quota-details.md).

`ProviderRow` owns identity, per-configuration quota selection, and its management menu. A container grid keeps quota beside the name when space allows and below it otherwise. The compact summary shows two windows and an additional-window count; details and the trigger's accessible description retain all windows. Refresh and delete keep their existing operations and confirmation, accessed through a menu labeled with the Provider's name.

`ProviderUsageDetails` owns the read-only remaining-quota summary, a persistent labeled “Quota details” button, and its popover. The visible button uses the standard raised control and a disclosure chevron; opening details does not depend on recognizing the metrics as clickable. A forecast is a separately attributed third-party entry inside that popover, with probability shown only in the forecast dialog. Eligible Codex rows with no reported quota retain a details entry and an explicit unavailable state. The dialog is hosted outside the popover so it survives dismissal. Neither listing Providers nor opening quota details requests a forecast; the explicit forecast action uses the existing shared store. Composer forecast loading and display are unchanged.

## Verification and limits

- 92 tests across the Provider row, machine detail, and forecast suites pass. A real-store integration test keeps the forecast idle through listing and quota opening, then observes its loaded state and empty-forecast dialog after the explicit forecast action.
- Eight English/Chinese Chromium cases cover wide/narrow layouts and missing quota, quota percentages versus probability, keyboard entry, popover-to-dialog handoff, refresh results, delete confirmation, and additional quota windows at narrow widths. Identity, quota and menu positions remain stable on hover.
- Playwright screenshots inspect default rows with actual synthetic 5h/7d data, quota details, and the named Provider menu.
- Full `pnpm check` remains limited by uninitialized ACP adapter submodules during CLI typechecking. Packaged Windows Electron verification is outstanding.
