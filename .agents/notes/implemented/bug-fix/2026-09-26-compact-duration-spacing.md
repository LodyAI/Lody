# Join Chinese duration with its label

Status: implemented
Translation: current

[中文](2026-09-26-compact-duration-spacing.zh.md)

## Abstract

The shared formatter already rendered Chinese compact durations as `7分25秒`,
but the surrounding labels still produced `工作了 7分25秒`. The chosen wording
is `工作了7分25秒`, without spaces anywhere in that duration phrase. The Chinese
labels now join directly to the formatted value; English remains `7m 25s`.

## Decision

The Chinese `sessions.workedFor` and `sessions.activityWithDuration` templates
omit the space before `{{duration}}`. The shared formatter retains an empty
Chinese `time.unitSeparator`, so its one-, two-, and three-unit outputs have
no internal spaces. English templates and formatting remain unchanged.

The [earlier separator decision](2026-09-25-duration-unit-separator.md)
continues to explain the shared formatter's unit-group spacing. This decision
changes the surrounding label. Current behavior is specified in the
[compact duration Spec](../../../../specs/compact-duration-spacing.md).

## Verification and limits

The duration test covers Chinese one-, two-, and three-unit values using the
shipped locale, both complete status templates, and unchanged English
formatting. Countdown chips format one short unit through a different function
and are outside this change.
