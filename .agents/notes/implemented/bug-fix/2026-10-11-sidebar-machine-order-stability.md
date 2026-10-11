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
Probe traces now distinguish request failures and recovery; the original outage
trigger remains unverified.

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

Static analysis traced identity loss upstream without changing runtime code.
The [CLI reporter](../../../../apps/cli/src/lib/cli-runtime-state.ts) receives its
machine id once in the startup command, before the local probe server starts;
connectivity changes do not clear it. Electron instead observes availability:
the [supervisor](../../../../packages/cli-supervisor/src/supervisor.ts) defaults to
a 1,000 ms poll interval, an 800 ms request timeout and three consecutive failures
before discarding the snapshot. An owned child can remain alive throughout this
transition and recover with the same id. PID mismatches, ownership loss and process
lifecycle transitions are separate paths that can also remove the snapshot.
The [main-process adapter](../../../../apps/electron/src/main/services/cli-service.ts)
folds every probe error, including connection, timeout and protocol errors, into
`null`. It already retains `cachedMachineId` for `getLocalMachineId`, but
`buildCliState` forwards only the supervisor's live snapshot. Consequently, the
renderer can observe `A → null → A` without the CLI changing its machine id.

Session navigation only changes the route; it does not restart the CLI or remount
the app-level probe effect. Opening an uncached session can join a document room.
The probe handler and local data-plane engine run in the same CLI process; the
[engine](../../../../packages/shared/src/local-loro-data-plane-server.ts) exports
Loro deltas and encodes payloads synchronously. Its shared scheduler yields between
tasks and frames but cannot preempt a single export. Inbound updates run through a
Promise chain outside this scheduler and synchronously import the reassembled
document delta. The frame limit is 32 MiB; chunking limits individual wire frames,
not the complete import or its CPU duration. Event-loop contention is therefore
a candidate for probe timeouts, not a measured cause of the recording. Local room
cloud hydration is bounded to four tasks and does not activate SessionDocument
wrappers. In dual mode, known-remote session rooms mount only the cloud transport,
so clicking any session cannot be assumed to cause a local CLI document import.
In dual mode, identity loss also changes the workspace target router's local/cloud
selection and invokes `refreshTransportRoutes`; recovery invokes it again. This
can add synchronization work, but a feedback loop has not been demonstrated.
Ordinary backend reconnection alone does not explain identity loss.

There is also an initialization-only race: `localProbeEffectAtom` accepts the
initial `getState` result and pushed states without a revision check, and an initial
read rejection clears the live identity even after a valid push. This cannot
explain repeated session-click fluctuations without an additional remount or reload.
Before this investigation, probe errors lost their classification at the
main-process adapter. CLI timer-lag warnings and stall profiling default to
5,000 ms and 4,000 ms
thresholds respectively; absence of those logs cannot exclude shorter delays that
exceed the 800 ms probe timeout. Establishing the original trigger requires
correlated probe error, duration, PID and lifecycle evidence from the recording
device. The implemented change stabilizes presentation; it does not repair or
identify an upstream probe outage.

Inspection of available local logs found backend reconnect transitions that
retained runtime snapshots, and a startup gap before the probe server listened.
It did not establish repeated snapshot loss on the recording device. Installed
desktop renderer bundles use the same snapshot-based identity derivation, but
the installed files do not establish the version loaded by a running process or
the version used in the recording.

`CliService` now observes typed probe errors before returning `null`.
`createCliProbeTrace` writes error type, request duration and timeout, child PID,
HTTP status when applicable, and consecutive request failures. It logs the first
and third failure, changes in error type, and continuing failures every 30 seconds;
recovery records the observed PID and whether a nonblank machine id is present.
The count includes startup/reconcile requests and is not the supervisor's poll
counter. Healthy polling stays silent. Payloads, causes, error messages and actual
machine ids are excluded; tracing failures cannot alter the probe result.
Supervisor transition logs also include identity presence. This corrects the
overbroad reconnecting/stall inference in the earlier
[daily-log tracing note](../feature/2026-09-25-daily-log-crash-and-stall-tracing.md).
No timeout, routing or process-lifecycle behavior changed.

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
The existing desktop-log suite also verifies persisted probe classifications,
failure milestones, the 30-second summary boundary, recovery/reset, exclusion of
private payload fields and survival of a failing diagnostic sink using an injected
clock. All nine tests passed.
The Electron suite passed all 214 tests outside the sandbox after its loopback
lease tests initially failed with `listen EPERM`. The desktop-log suite also
passed with a negative-offset timezone; log-file lookup uses the local-date helper.
