# Settings surfaces

Binding guidelines live in [AGENTS.md](AGENTS.md).

## Loading settings

Component-only settings routes use TanStack `.lazy.tsx` files. Search validation
stays in the eager route files. These source boundaries apply to every application
that consumes the shared route tree without requiring an application router plugin.
The desktop modal loads on its first open and remains mounted afterward so closing
preserves its existing behavior. Each selected panel loads through its own React
Suspense boundary. Once the workspace shell is ready, an idle task warms the
modal shell and default panel (Account when cloud accounts are available,
Preferences otherwise). Mobile warms only that panel. The task is canceled when
the shell unmounts. Hovering or focusing the shared sidebar settings entry warms
the same code; hovering or focusing a modal tab or mobile category warms only its
panel. These shared boundaries apply to Web and Electron. Warming imports code
without mounting a settings component or starting its subscriptions. Concurrent
warm-up and opening share the loader promise; failed speculative loads are cleared
so a later open can retry. Other panels remain deferred.

Run `NODE_OPTIONS=--max-old-space-size=12288 node apps/electron/scripts/check-settings-route-chunks.mjs` from the repository
root to build the actual OSS renderer and verify that the modal, usage statistics,
MCP and Lody Agent settings are outside the main entry's static chunk closure.
The check uses the application's renderer configuration and dependencies, skips
main/preload, and writes no build artifacts. It does not measure Cloud-specific
composition overhead or navigation latency.

PR review Markdown offers per-image HTTPS loading; automatic loading is a
device-local preference, off by default. The isolated desktop image document
keeps the main renderer's image policy unchanged. [Decision](../../../../../.agents/notes/implemented/feature/2026-11-02-pr-remote-images.md).

## Ordinary member approval

The join-request subscription and Better Auth's member cache have different owners.
After approval commits, Settings refreshes the member cache immediately. The
existing subscription's optional `membershipVersion` also refreshes it on open
and after changes from other devices. Refreshes keep a pending change while an
older read settles; a cache failure never reports the approval as failed.

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

Machines > the selected owned daemon > Advanced settings > Restore old machine
identity selects another owned, offline registration in the current workspace.
The source may be remote. The daemon advertises `machineIdentityRestore: 1` and
must support supervised restart. The server authorizes both registrations and requires
an active source-machine credential binding; unbound account API keys cannot recover
an identity. Sharing access never grants recovery. The user must confirm that no machine is running with the old identity. Revocation covers its dedicated machine credentials, not manually
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
The confirmation shows that pairing notice only in an encrypted workspace.

Deployment requires the cloud `machine-lifecycle/restore-identity` endpoint and
receipt schema before enabling recovery on clients. Unit fixtures do not establish
Windows filesystem, remote restart or encrypted pairing acceptance.

## GitHub installation

App installation requires personal operation authorization before opening GitHub;
this does not enable the separate operation preference. Installation advice stays
visible until the user repairs authorization or retries. The retry capability stays
in a fragment or the same-tab OAuth proof, never a search parameter. Navigate only
to the configured Convex Site origin and exact installation callback contract.
Preserve the error and fragment through desktop handoff, and fence late OAuth
completion against navigation and workspace changes. Session replay omits URL
fragments; controls containing the capability stay outside replay capture.

The workspace-independent `/settings/github` landing waits for the signed-in
user's live member-workspace list. It selects an active workspace only from that
list, otherwise using the existing member-list preference. Unsigned callback
parameters never select the workspace or a desktop target. Anonymous returns use
the existing login flow; retry capabilities are never placed in its redirect query.
