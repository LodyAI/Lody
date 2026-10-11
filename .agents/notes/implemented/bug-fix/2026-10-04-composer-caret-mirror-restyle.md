# Keep caret measurement from restyling the application

Status: implemented
Translation: current

[中文](2026-10-04-composer-caret-mirror-restyle.zh.md)

## Abstract

Opening `/` or `$` mention menus could stall a large page even with very few
candidates. Each caret measurement appended a temporary mirror after `<body>`,
changing its `:last-child` state before a synchronous layout read. Inserting the
mirror before `<body>` preserves that state and the unscaled measurement space.
In real Chromium with 12,000 synthetic background rows, opening fell from
859–908 ms to 20–30 ms; this is component evidence, not a production-window trace.

## Decision

Keep the mirror's existing lifetime, layout properties and caret arithmetic;
change only `appendChild(mirror)` to `insertBefore(mirror, document.body)`.
Repeated floating-position reads still measure current wrapping, scroll and scale.
The [caret-placement decision](2026-09-29-composer-mention-follows-caret.md) remains
valid. This closes a separate insertion path from the earlier
[portal restyle fix](2026-09-23-portal-full-restyle.md): a sentinel inside `<body>`
protects the app root's sibling position, not body's position under `<html>`.
Placing the mirror inside body was unnecessary and could expose it to app
transforms. Caching, a persistent mirror and menu virtualization are not needed
for the measured defect.

## Evidence and reproduction

Upstream main was still `4ccb2fe7575227fa5594d5735064b64048e106bd` on October 4.
A separate Storybook served this worktree on port 6016. In headless Chromium,
load `mentions-mentiontwolevelmenu--floating-in-composer`, append 12,000 synthetic
styled rows under `#storybook-root`, then type `/` and `$` twice each, clearing
between inputs. Measure input-to-second-animation-frame delay and CDP
`Performance.getMetrics` / `UpdateLayoutTree`, without CPU throttling.

| Observation | Before | After |
| --- | --- | --- |
| `/`, 2 options | 859–879 ms | 20–30 ms |
| `$`, 8 options | 889–908 ms | 23–27 ms |
| Cumulative style recalculation per opening | 1.05–1.10 s | 1.8–2.8 ms |

Before, repeated style updates touched about 12,043–12,082 elements; after,
the costly whole-page updates disappeared. A repeat differential using a
browser-only reversal of the insertion line found maximum update sizes of
12,046 → 19 elements for `/` and 12,082 → 51 for `$` (fixed delays 22–33 ms).
Ordinary typing was about 13 ms before. The main-composer stress story also opened its 24-command menu in
27–39 ms with the same background DOM. These are exploratory measurements,
not CI timing budgets.

The owning [browser suite](../../../../packages/components/tests/e2e/composer-mention-placement.spec.ts)
observes real geometry reads and asserts that body still matches `:last-child`
while the mirror is mounted. Both trigger cases failed before the source fix
and passed after it. MutationObserver alone would miss the synchronous state,
since the mirror is removed before observer delivery. The suite also covers
filtering, keyboard/mouse selection, Escape, wrapping, a scrolled textarea,
transform/zoom, desktop bounds, dialog and inline menus. The resize assertion
now awaits the resulting bounds rather than racing the positioner's update.

Executed checks: 11 browser tests and 70 focused component tests passed,
including mobile docking. Scoped formatting and type-aware lint passed
(lint retained nine warnings in the existing code). Docs check passed with
64 existing warnings after initializing submodules from the local checkout;
there are no registered SHA-protected topics.

## Limits

A separate manual-scroll probe found an existing placement gap: changing only
textarea `scrollTop` from 79 to 59 left the popup at the same y coordinate.
Both original and fixed insertion paths behaved identically. Typing into an
already scrolled textarea and scale changes pass; scroll-only repositioning
remains outside this performance fix and is not claimed as verified.

The component typecheck cannot pass with the reused installation: viewer
dependencies and the ACP core SDK are missing. No full desktop build or actual
production window was tested. The [placement Spec](../../../../specs/composer-mention-menu-placement.md)
remains draft; these measurements do not confer human approval.
