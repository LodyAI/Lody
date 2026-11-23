# Runtime conversation capture in Devbar

Status: implemented
Translation: current

Implementation: [PR #860](https://github.com/LodyAI/Lody/pull/860)

[中文](2026-09-21-devbar-conversation-capture.zh.md)

## Abstract

Investigating a brief chat flash required instrumentation before entering the
session, while attaching a browser debugger required restarting the installed
app and its agents. The existing runtime Devbar now offers an explicit bounded
conversation capture and clipboard report in the current renderer. It records
viewport geometry and lifecycle observations without conversation content or
private React inspection. It does not supply pixel evidence, CPU stacks, a cold
cache guarantee, or attribution of the reported real-session flash.

## Decision

Extend the [existing Devbar](2026-09-16-devbar-hub-ui.md) footer rather than add a
remote-debugging listener or privilege to its Hub. The user starts capture before
navigation and stops it after the problem; completion presents re-hide and empty
viewport counts and a copy action. The existing Developer Mode boundary still
owns availability. Enabling Devbar reloads the renderer, so users must enable it
before opening the target, not after a cold-entry failure.

A DOM sampler reads the existing conversation viewport/virtual-row attributes.
A pure bounded recorder classifies transitions on the same observed route:
initially hidden is normal; hiding after reveal, disappearing panes, replacement
panes, empty visible-row windows and retained-anchor shifts are separate events.
A route change resets the reveal baseline. Long Tasks and input kinds provide
relative timing context; input values and DOM text are never read. Route and row
aliases are local to the capture. The report remains in renderer memory and is
copied only on request. The [Spec](../../../../specs/desktop-devbar.md#conversation-capture)
owns limits, cleanup and export guarantees.

DOM inspection avoids changing reader/virtualizer ownership or depending on React
Fiber internals. The trade-off is deliberate: a paint-only flash or internal
projection replacement may require later dedicated instrumentation. Geometry
changes are not automatically bugs. No confirmed real-session root cause follows
from adding this recorder; see the [earlier attribution correction](https://github.com/LodyAI/Lody/pull/856).

## Verification

The owning Devbar suite exercises reveal versus re-hide, navigation reset, row
loss/remount, retained-anchor displacement versus user scrolling, event/sample
bounds and terminal stop behavior. The runtime adapter is exercised with explicit
frame and visibility signals, including sampler failure and cleanup. Browser
verification used the actual start/stop/copy controls over synthetic DOM content:
two hide/reveal cycles and one visible-row removal produced exactly two re-hides
and one empty-window observation, with no message text in the copied report. All
156 Electron tests, node/web typechecks and scoped lint pass. Installed-app cold
entry remains an acceptance task after this implementation is built into Desktop.
