# Space compact Chinese durations consistently

Status: implemented
Translation: current

[中文](2026-09-26-compact-duration-spacing.zh.md)

## Abstract

The previous duration change joined Chinese unit groups as `7分25秒`, but the
requested UI wording is `工作了 7 分 25 秒`. Compact durations now have separate
localized gaps between numbers and units and between unit groups. English keeps
`7m 25s`; countdown chips retain their separate short-label format.

## Decision

The shared formatter reads `time.numberUnitSeparator` and the existing
`time.unitSeparator`. Both are spaces in Chinese; English keeps an empty
number-unit separator and a space between groups. The surrounding
`sessions.workedFor` and `sessions.activityWithDuration` templates already
provide the single space before the duration.

This replaces the Chinese spacing choice recorded in the
[earlier separator decision](2026-09-25-duration-unit-separator.md); that note
remains historical evidence for why one shared formatter owns these surfaces.
The current behavior is specified in the
[compact duration Spec](../../../../specs/compact-duration-spacing.md).

## Verification and limits

The duration test covers Chinese one-, two-, and three-unit values using the
shipped locale, the full `工作了` phrase, and unchanged English formatting.
Countdown chips format one short unit through a different function and are
outside this change.
