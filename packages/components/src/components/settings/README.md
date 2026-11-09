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
verification do not mount connection-management probes. Selecting a sign-in method
opens a dialog for its progress, input and errors. Each custom endpoint retains an
API key action while the advertised-method cache refreshes; the daemon validates
the selected method against the agent before requesting credentials.

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

## Restoring a daemon identity

Machines > the selected owned daemon > Advanced recovery > Restore old machine
identity selects another owned, offline registration in the current workspace.
The source may be remote. The daemon advertises `machineIdentityRestore: 1` and
must support supervised restart. The server authorizes both registrations and requires
an active source-machine credential binding; unbound account API keys cannot recover
an identity. Sharing access never grants recovery. The user must permanently stop the old installation
before confirming. Revocation covers its dedicated machine credentials, not manually
issued account API keys or already issued transport tokens.

Recovery uses a target-bound restart proof and a retained server receipt. Verification
must echo the exact request and target after reservation; a legacy success response
cannot authorize restart. The live
daemon saves only an intent; the next supervised worker reconciles it before auth
or workspace startup. It backs up credentials, confirms the exact server operation,
then updates the authoritative credentials and installation ID. Unknown results
retain the intent and original files for exact retry. Network, timeout and server
failures retry without consuming the watchdog crash budget; explicit rejection stops
startup with the intent retained. An interrupted two-file publication is repaired only
after reconfirming the same operation, before a runtime can start. Original source registrations,
conversations and project files are not migrated or removed. Changing an ID grants
no encrypted device admission; encrypted workspaces need fresh approved pairing.

Deployment requires the cloud `machine-lifecycle/restore-identity` endpoint and
receipt schema before enabling recovery on clients. Unit fixtures do not establish
Windows filesystem, remote restart or encrypted pairing acceptance.
