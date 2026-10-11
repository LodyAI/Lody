# Stable sidebar machine order during CLI outages

Status: implemented
Translation: current
PR: [#1488](https://github.com/LodyAI/Lody/pull/1488)

[中文](2026-10-11-sidebar-machine-order-stability.zh.md)

## Abstract

The sidebar used the live CLI machine identity to place the desktop's machine
section first. When a runtime snapshot disappeared, that section returned to
name ordering and moved again when the snapshot recovered. A separate presentation
identity now retains the last confirmed machine for ordering while local actions
continue to use live runtime state. Disabling the local agent clears the preference;
a newly reported machine identity replaces it.

## Decision and evidence

`CliSupervisor.pollRuntimeState` clears `latestRuntimeState` after probe failures;
Electron's `buildCliState` consequently publishes a state without `runtime`.
`localProbeEffectAtom` maps that absence to a null `localMachineIdAtom`.
The sidebar then moves the former local section among remote sections, which
previously sorted only by ownership and name. Recovery moves it back to the top.
These are internal ordering rules, not a user-configurable sorting setting.
Frame inspection of the reported recording found whole-group swaps at 3.862 s
and 7.172 s, accompanied by the folder-import button appearing and disappearing
on iMac. That button is rendered only for `localSection`; its visibility and the
section's placement both derive from the live local identity. The selected row
was unchanged across the first swap. This ties the observed movement to changing
local classification rather than a read-state or selected-session sort.
There is no correlated CLI log from the recording device, so the upstream reason
for that identity change remains unverified. A `reconnecting` phase alone is
insufficient: snapshots that still contain the same machine identity do not reorder
this section.

`lastKnownLocalMachineIdAtom` retains a confirmed identity in renderer memory.
`compareSidebarMachineOrder` applies it before ownership, name and id ordering.
It affects only section placement: import/removal actions, current-machine labels,
local routing and startup gates retain their live inputs. Keeping the live identity
across outages instead would affect these unrelated consumers. Initial identity
discovery can still move the local section once; the preference is not persisted.

This preserves the device-first decision in the
[sidebar groups note](../feature/2026-09-25-deep-sea-palette-and-sidebar-groups.md)
and extends the [ordering Spec](../../../../specs/sidebar-project-ordering.md).

## Verification and limits

The regression suite drives the real probe effect through synthetic IPC state
events and compares resulting machine order through repeated reconnecting,
offline, starting, fatal and stopped states. It also checks that live routing
clears, explicit disable resets the preference, a replacement identity takes over,
and a failed initial IPC read does not erase a pushed presentation identity.
The existing project-order suite checks ownership and deterministic name ties.
All 23 tests across the probe, project order, keyboard navigation, rendered local
project rows and runtime-policy suites passed. Root type checking, `pnpm format`
and `pnpm check:quick` also passed. `NODE_ENV=test pnpm check` did not pass:
the Components suite had 4,887 passing tests and one failure in the unchanged
boot-shell storage-unavailable test, also reproduced standalone. Four CLI suites
initially failed on sandbox data-directory writes or inherited Git signing;
rerunning them with an isolated `LODY_DATA_DIR` and signing disabled for the test
process passed all 171 tests. `pnpm run docs check` reports six existing links
into uninitialized isolated Kimi/Pi submodules, with no error in changed documents.
Playwright also recorded the actual sidebar component from the base revision beside
the updated component, using identical synthetic catalogs and injected IPC states.
Two disappearance/recovery cycles moved the old iMac header by 200 px; the updated
header and session row stayed at their original positions (0 px displacement).
Real sidebar clicks opened the expected routes before and during reconnecting.
A second Playwright control held the identity constant through three session
clicks: neither version moved. Without clicking or changing routes, names or read
state, identity disappearance/recovery then moved only the old version, while the
import button followed live identity in both versions. This matches the two visible
signals in the reported recording. Both runs had no page errors. Catalog hooks
and selected-session read updates were fixture inputs. This browser renderer
acceptance does not exercise a live Electron process or establish which CLI states
occurred in the user's original recording.
The recording and its fixture remain in ignored local artifacts.
