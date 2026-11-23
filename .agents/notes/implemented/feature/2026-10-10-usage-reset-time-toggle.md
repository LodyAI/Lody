# Toggle usage reset time formatting

Status: implemented
Translation: current

[中文](2026-10-10-usage-reset-time-toggle.zh.md)

## Abstract

Composer quota details previously displayed only relative reset times despite receiving
absolute Unix timestamps. Each reset row now includes the existing Lucide ArrowLeftRight
icon in a shared UI button to switch between relative and absolute time. Absolute dates
use the product language and local timezone. Each row retains its choice only while mounted.

## Decision

This extends the [usage indicator](../bug-fix/2026-10-01-five-hour-usage-indicator.md).
`ResetTime` owns presentation state and uses `resetsAtEpochSeconds` without protocol
changes. Rows without timestamps have no toggle. The translated accessible name and
title describe the target format; absolute text can wrap inside the narrow popover.

## Verification

Existing `ContextAndQuota` and `QuotaOnly` stories expose the controls. Both usage
suites pass (20 tests), and Oxfmt and translation-key checks pass. Chromium checks
on the actual QuotaOnly story verify English and Chinese desktop (1000px) and narrow (375px)
layouts, independent rows, click-to-absolute and Enter-to-relative round trips,
with no page errors. Screenshots were inspected. The local Storybook server is
registered with Lody Preview; full desktop application integration was not tested.
Documentation checks still report existing links to absent ACP submodule files.

Repository `pnpm format` passes. Full `pnpm check` stops during typechecking
because dependencies outside the installed UI workspace subset are missing
(e.g. `packages/ignore` cannot resolve `effect` and Node types).

PR: [#1416](https://github.com/LodyAI/Lody/pull/1416).
