# Settings surfaces

Binding guidelines live in [AGENTS.md](AGENTS.md).

PR review Markdown offers per-image HTTPS loading; automatic loading is a
device-local preference, off by default. The isolated desktop image document
keeps the main renderer's image policy unchanged. [Decision](../../../../../.agents/notes/implemented/feature/2026-11-02-pr-remote-images.md).

## Agent Role summaries

Role rows resolve saved model, mode and option IDs against the bound machine's
agent capabilities, using the same selector catalog as the editor. Unknown IDs
remain visible when a capability is missing; display labels never replace stored
execution values. Multi-machine rows compare raw summaries before displaying a
shared label, so equal model names do not hide different model IDs.

## Lody Agent setup

The Lody Agent page exposes saved connections and custom endpoints while the
initial setup is awaiting authentication, using the pending config on the target
machine. Completing authentication lets the daemon resume verification; only a
successful verification publishes the Agent config. Runtime preparation and
verification do not mount connection-management probes.

Connection management uses the target machine’s local capabilities for same-machine
IPC and its remote capabilities for encrypted workspace RPC. A remote machine in a
plaintext workspace can use the existing ACP sign-in flow, but cannot manage Sorbet
custom endpoints through the encrypted-only Provider API.

## Usage range transitions

`usage-calendar-visualization.tsx` keeps a positioned view frame across hourly and
calendar ranges so exiting charts retain their measured coordinates. The hourly
ring grid changes inside that frame. Whole-view opacity fades handle the handoff;
calendar cells render together without individual reveal animations. The
[transition decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-21-usage-range-transition.md)
records the misplaced-chart reproduction and browser coverage.

## Machine connection marks

`workspace-machine-accordion.tsx` renders the connection mark for collapsed and
expanded machine cards. An online machine keeps its solid green centre while
its halo expands and contracts at a constant speed over 2.8 seconds, using linear
CSS transform and opacity animation. Each direction takes 1.4 seconds.
Offline machines keep a static gray dot. Reduced motion keeps the online halo
static. Motion follows the existing `isOnline` value and adds no presence polling.

The [OnlineStatusMotion story](../../stories/DevicesDesktopLayout.stories.tsx)
uses the real machine card with a controlled online/offline value for inspection.
