# Keep open-source notices scrollable inside their dialog

Status: implemented
Translation: current
PR: [#1593](https://github.com/LodyAI/Lody/pull/1593)

[中文](2026-10-15-open-source-notices-scroll.zh.md)

## Abstract

The open-source notices dialog clipped long lists without allowing scrolling,
so users could not reach the later entries. Its height-capped ScrollArea now
lays out the viewport as a shrinkable flex child. The summary cards share the
scrolling body so stacked cards cannot consume all list space in a short window,
while the heading and close control remain outside it. Chromium browser tests
reach the final bundled and dependency entries at three window sizes; packaged
Electron and touch-device verification remain outside this check.

## Cause and fix

The ScrollArea root had `max-height: 70vh`, but its viewport used `height: 100%`
without a definite containing height. In a 1180×800 browser window, the root
was 560px tall while the viewport's client and scroll heights were both 1948px.
The root hid overflow, and the actual viewport had nothing to scroll. Making
the root a flex column and setting the viewport's minimum height to zero lets
the viewport shrink inside both the root cap and the dialog's height cap.

Keeping the summary outside that scroll body had a separate failure: after
the three cards stacked at 400×360, the remaining viewport height was zero.
The summary now precedes the accordions inside the same viewport, separated
by token spacing. The existing Radix scrollbar, accordion controls, license
selector, modal focus containment, and deferred trigger behavior remain owned
by their existing components. A fixed viewport height was unnecessary and
would require accounting for the responsive header and summary separately.

This complements the earlier [dialog width fix](2026-09-25-dialog-content-width-prop.md)
and [trigger timing fix](2026-09-25-base-ui-trigger-prevent-default.md); their
decisions are unchanged. Current ownership is documented in the
[product surfaces README](../../../../packages/components/src/components/README.md#about-notices).

## Verification

The existing [desktop settings browser suite](../../../../packages/components/tests/e2e/desktop-settings-layout.spec.ts)
opens the real nested About dialog at 1180×800, 707×394, and 400×360. Each case
checks scroll overflow and bounds, actual wheel movement, visibility of the last
bundled entry and last MIT dependency, the license selector, and focus return on
dismissal. All three cases fail on the original layout and pass with the fix.
These checks use the shipped attribution bundle and explicit browser state,
without network fixtures or fixed sleeps.

Component typechecking, scoped lint, and formatting checks pass in the original
checkout. Its full desktop settings browser suite passes 19 of 22 cases; its two navigation-focus
failures and missing Role-sharing-switch failure also reproduce with the
original notices component restored. Repository documentation checking reports
six existing broken links in the bilingual subagent-events proposal, with no
errors in the changed documents and no registered SHA-protected topics.

On the PR branch based on current `main`, root `pnpm format` passes. Full
`pnpm check` stops while building the unchanged Claude adapter because the reused
installed SDK types lack fields such as `run_id` and `availableCommands`. A fresh
dependency graph and full PR validation remain for CI.
