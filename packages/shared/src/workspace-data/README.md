# Workspace Repo ownership

Workspace roots call `make` from `loro-repo/effect` in their owning Scope.
Borrow document and room leases in caller Scopes; `openDoc` preserves absence,
while `createDoc` explicitly registers an identity. CLI directory reads and metadata
confirmation use this Repo directly at their business entry points.

`streams.ts` configures the native SDK with the existing token service.
`local-transport.ts` is the product's v7 client. The previous client is a frozen
host compatibility fixture under `test-support`, excluded from package exports.
Peer convergence, server upload confirmation and local durability remain separate.
Same-store Doc cursors are reused explicitly; Meta/Flock checkpoints stay bound
to their replica, and isolated eager workers use volatile checkpoints.

Existing Promise consumers enter through `WorkspaceRepoLegacy`. Legacy Doc/Flock
handles borrow a cached native replica. Store disposal stops projections and
releases its borrow; the cache then attempts eviction, persisting before closing
the cached hold. A failed save retains the same borrowable replica, so another
view can open while storage remains unavailable. The eviction wait uses the
native release deadline; a timeout leaves accepted
adapter work owned and the same replica available, without confirming persistence.
Genuine native release failures remain retryable and exclude unsafe replacement.
Workspace shutdown continues independent cleanup; Repo/storage close still
depends on retiring native borrowers and private SDK producers. Calling dispose again retries
unresolved owners while new work stays fenced; unsettled writes keep their storage.
Scope recovery recognizes both Repo release receipts and the SDK's
`DurableReleaseFailure.retryRelease`, including constructor/connect/join finalizers.
Successful retirement clears the retained failure; a closed Scope is not replayed.

Room handles retain the native `RoomLease` and the small UI status view still in
use. Each first-sync read waits on current native state. A caller keeps its failed
wait, while later reads can succeed after the same binding recovers. The room
borrow's cancellation still ends all its waits. Inventory and transport snapshots come from native leases; the local owner
registry exists only to release borrows during purge. On an online transport,
recovery syncs/reconciles failed or offline rooms, collecting independent failures.
Failed SDK initialization can still project as joining: consult the native health
for an unready initialization with a non-retryable error or an expired initial-sync
hard deadline, and no pending accepted I/O. The hard deadline ends initialization
even though `initial_sync_timeout` is retryable.
Selected sync can restart that SDK generation while ordinary baselines stay owned.
Live 4xx failures already use SDK backoff; an HTTP error does not prove a terminal
generation. A persistent room error never resets healthy siblings or presence.
Only transport failure restarts a shared server connection; wake/auth/force requests
while online use selected-room repair too. Forced peer reconnect still drains and
rebuilds failed local v7 workers. Native ownership keeps
pending SDK work and scopes, without a second set of application rejoin jobs.
The local v7 client keeps its 1,024-event and default 64 MiB queue bounds.
After overflow, reconnect (including a physical online edge) drains the failed
worker and replaces its queue, clears incomplete protocol state, then catches up
from the retained replica. Pending barriers fail; new barriers can succeed after
recovery. The Doc/Meta/Flock leases and other rooms remain owned by their Scopes.
Physical connection events dispatch without waiting for a room to drain. A scoped
FiberMap coalesces overflow recovery by member identity; healthy rooms keep receiving
later offline/online edges. Room close and recovery still share their lifecycle gate.
Native waits at Promise entries use the room borrow's signal so retiring one
Session cancels only its wait while independent borrowers remain writable.
First-sync readiness stays separate from `waitUntilSynced`: the latter captures
the current version for a server upload ACK, or requires a selected peer protocol
receipt. Offline, absent and unsupported routes cannot report write success.
Transport Scope owners are registered before adapter construction and native
connect. Removing one cancels its acquisition and closes its Scope, including
native registration and accepted connection work. Late completion cannot publish
the old owner or delete its successor; the next add retries failed release.

The writer records newly authored Provider rows. A local ACP probe waits for
Machine Flock peer coverage only while its config has a pending write, returning
a failure response on an unconfirmed handoff. Routine refreshes do not wait for
the data plane; saves remain local-first. Cancellation or disposal prevents late
process launches.

Implementation rationale and acceptance limits: [native ownership](../../../../.agents/notes/proposed/architecture/2026-10-16-native-workspace-repo.md).
