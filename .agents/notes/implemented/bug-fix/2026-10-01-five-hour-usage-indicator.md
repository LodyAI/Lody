# Prefer five-hour subscription usage in the composer indicator

Status: implemented
Translation: current

[中文](2026-10-01-five-hour-usage-indicator.zh.md)

## Abstract

The composer sorted subscription windows by descending duration for its popover,
then reused the first window for its compact indicator. This always selected weekly
usage when a five-hour window was also available. The indicator now selects the
five-hour window explicitly, retaining the existing fallback and context priority.
The popover continues to show every reported window in its existing order.

## Decision

This extends the [new-session usage display](2026-09-28-session-tab-rate-limit-ring.md)
with independent window selection in `SessionUsagePopover`. Reversing the shared
array's sort would also reorder the details, so the indicator instead finds the
five-hour window before falling back to the first displayed window. Zero usage is
a valid selection. Provider/model resolution and normalization remain with the
existing helpers.

The [display Spec](../../../../specs/session-usage-indicator.md) owns the intended
behavior; the [session directory map](../../../../packages/components/src/components/sessions/README.md)
links to it. The existing `QuotaOnly` Storybook case already supplies both windows.

## Verification

The two usage suites pass all 20 tests, covering both provider input orders, zero
five-hour usage, accessible indicator text, preserved popover order, weekly-only
fallback, and context priority after rerender. Both new cases failed before the fix.

An independent clone with initialized submodules passes repository typechecks,
lint, formatting, documentation checks, and boundary guards; Electron's 199 tests
also pass. `pnpm check` still fails at `boot-shell.test.tsx`'s storage-unavailable
case (1 failure, 4,592 component tests passing); restoring the original usage
component reproduces it on Node 26.10.0, indicating it is unrelated to this fix.
No manual application UI verification was performed.

PR: [#1201](https://github.com/LodyAI/Lody/pull/1201).
