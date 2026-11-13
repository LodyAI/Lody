# Shared runtime source and dependency updates

`runtime/vendor/cloud-runtime` snapshots this monorepo's `apps/mobile/ios/packages/cloud-runtime`
verbatim. `vendor/PROVENANCE.json` records the base commit and reviewed updates.
`vendor/SHA256.json` records every mirrored file. Each asset build checks the
snapshot for changed, added or missing files and symlinks. The drift test modifies
a disposable copy.

For Roost, snapshot the generated `src/runtime/upstream-roost.js` and the runtime
licenses. Keep `vendor/upstream-roost/` and `scripts/build-upstream-roost.mjs` in
the iOS package, where the iOS asset build verifies the generated module.

For an intentional update:

1. Select and record a reviewed upstream commit. Export `apps/mobile/ios/packages/cloud-runtime` into a temporary directory using `git archive <commit> apps/mobile/ios/packages/cloud-runtime` and omit the two Roost authoring paths above.
2. Compare that export against the current snapshot. Review protocol changes, licensing and browser dependencies. Preserve Android adaptation in `runtime/src`, outside the snapshot.
3. Replace the snapshot only after reviewing the diff; update PROVENANCE and SHA256 together. Generate hashes with the exported `hashes()` function in `runtime/snapshot.mjs`, directed at the reviewed source directory. No build regenerates the manifest automatically.
4. Run snapshot verification, `npm ci`, JS tests, asset build, JVM and Android bridge tests. Update `runtime/contract/fixtures.json` only for an intentional contract change. Capture actual WebView/WASM results and verify release assets contain no diagnostics.

Android bundles Loro through `runtime/src/loro-wasm.mjs`: both `loro-crdt` and
`loro-crdt/base64` resolve to the official `loro-crdt/web` entry, with its WASM bytes
inlined by esbuild and initialized asynchronously before dependent modules run.
This avoids the base64 entry's synchronous `new WebAssembly.Module`, which Android
WebView can reject above 4 KiB on its main thread, including on supported devices.
Flock's base64 entry already initializes asynchronously. No network fetch, vendor
patch, dependency change or WebView upgrade is required. The real WebView suite
checks production document readiness and actual Flock/Loro snapshot round trips.

The production lockfile remains pinned. Phase 1 reported Zod advisory **GHSA-mrhx-c7xc-m3w5** against 3.25.76. Phase 2 pins **4.6.7** and verifies real shared schemas: accepted identities, strict extra-field rejection, shortcut variants, share object validation, and oversized constrained collections failing before per-item error allocation. The oversized-input test failed on v3 and passes on the patched version. `npm audit --omit=dev` reports zero known vulnerabilities for this lockfile. No source snapshot changes or v3 compatibility shim were needed.

The Roost update in `PROVENANCE.json` records the upstream bridge, input
coordinator and storage packaged in the browser module. With Developer Mode and
the Roost History beta preference enabled, new conversations and Tabs use Roost
on compatible owners and Loro on other owners. Session metadata stores the choice.

Roost sessions use the owner machine's encrypted history RPC while Loro carries
the control document and queue. The upstream coordinator persists pending inputs
in IndexedDB under the backend, account and workspace, recovers the original input after
restart, and serializes inputs for a session. Sign-out does not clear the pending
input database. Queue-to-guide conversion preserves the queue item when local input
saving fails. Archiving or deleting a Roost session cancels its pending inputs before changing metadata.
A user can retry the original input after a failure, or cancel a pending
input while its session is syncing,
although an owner may already
have accepted it. The native transcript opens at the latest page and requests
older pages when needed. The Android runtime test exercises the bundled production
session module with a synthetic Streams peer.

Roost proposal decisions write the outcome through the owner's shared
`replaceTurn` command, as on Web. The Loro path continues to append the notice
update to its session document.

References: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 and https://zod.dev/v4/changelog. Audit evidence is retained separately for each phase.

Bridge protocol 2 adds an explicit command capability handshake, `$cancel`, native command deadlines, and ordered message chunks. It wraps the original JS runtime; it does not change the upstream cloud protocol. Fixtures use synthetic catalog data matching the vendored event shapes, not captured user data. The offline document exposes `ping`, `setActive`, and `probeSchema`. The network document additionally advertises `connect`, `grant`, `watchSession`, `closeSession`, `creationOptions`, and `createAndSend`, used through the native scoped runtime. Session reads reuse the upstream Loro projection and emit typed text messages to Compose. Both network gates restrict reads and the creation/dispatch writes described below to the current workspace; returning to the list stops the session subscription.

The snapshot carries every catalog field Android reads (session owner, `machineOs`, git
state, PR merge state), the 16 MiB per-replica catalog input budget and per-config
creation capabilities, so no bundle-time source adapters remain. A later difference
belongs in the next re-snapshot, not in a patch over the snapshot. `catalog-budget.test.mjs`
still runs the bundled watcher against a synthetic transport to pin the budget.

The snapshot at `7f742986` gates the composer's prompt shortcuts by their saved project,
computer and agent scope (as web) instead of dropping every scoped or referencing one,
answers `cmd` mention reads from the runtime's last shortcut listing while reading a fresh
one, and reports a listing with an unreadable or pending owner index as incomplete rather
than empty. The `promptShortcuts` list action (Settings and `shortcutBody`) lists what is
readable; send-time `/shortcut:` expansion keeps the strict listing.

The snapshot at `6308c98c` adds `androidEmulatorControl`: the signed `android-emulator/control`
lifecycle call (list/start/status/stop, with `quality` sent only to hosts advertising
`androidEmulatorQuality`), whose viewer URL arrives encrypted to a per-request key exactly as
`iosSimulatorControl`'s does. The catalog adds `machineEmulators` (any OS whose CLI advertises
`androidEmulator`) and each session's `androidEmulatorPreviewRequestId`. It also carries main's
mention-expansion wording.

The snapshot at `44771001` makes `listDir` (Project files) list the conversation's own
folder, its worktree when it has one, through the machine's `file/list-dir` (capability
`sessionDirectoryListing`), so the list matches what `readFile` opens. Machines without the
capability, and encrypted workspaces whose machines answer `unsupported_protocol`, keep the
local-project listing.

The snapshot at `2d1971eb` projects Agent Role and schedule proposal notices (`proposal`) and
agent file `mimeType` into the transcript, and adds `decideProposal`: Save writes the Role through
the Agent Roles settings path, Create saves the schedule under the proposal id, and both record the
outcome in the notice. An unconfirmed upload keeps the proposal undecided for an explicit retry.

The snapshot at `76340385` adds each Project group conversation's members to the catalog
(`projectRun`: placement order, branch, diff, publish state and the current PR per repository,
for the group context capsule) and the group's `ownerUserId` to `projectGroups` (Settings ›
Projects).

The snapshot at `041760cf` adds catalog `Project.repositories` for multi-repository projects
(their `projectRun` GitHub members), which the conversation uses to open its members' PR links
in the native PR panel. It also carries the runtime's prompt shortcut caches (access directory
for 30 s, grants, bodies; forgotten when the account or workspace changes): Settings lists with
`fresh`, while the composer's `shortcutBody` may use the recent directory. The unused
`publishedShares` call is gone.

## Catalog read recovery

Catalog transport, authorization and rate-limit failures retry from the last
successfully imported offset and cursor, retaining the verified in-memory Flock.
The watcher reports failure and stays unhealthy until an `upToDate` response;
partial catch-up cannot publish a synchronized catalog. An explicit Android
`runtime_suspended` abort retains the grant; actual transport/auth failures
invalidate it before retrying. Malformed responses, invalid cursors and corrupt
imports still take the bootstrap recovery path. The cumulative input budget
survives read retries, and `catalog_limit` remains terminal. Owner cancellation
ends retries without publishing late results. Writes are never replayed.

## Android text creation

`create-commands.mjs` exposes creation options and create-and-send using native scope identity. Presence is read through the grant origin; the UI only offers currently online agents. The adapter calls upstream creation, session bootstrap and text send in order, retaining IDs and never retrying writes. Before the write, a selection the live options or Roles refuse, or a failed read of them, reports `rejected`; after it, only a channel refusal made before the handler runs (`invalid_params`, `unsupported_method`) is `rejected`, and every other failure is `unknown`. Like iOS `WorkspaceBilling`, `ReadOnlyCloudRuntime` reads the workspace plan projection (`billing:getWorkspaceBillingEntitlement` → `{effectivePlanTier, checkoutPending}`, cached for a minute after a successful read) through its `BillingProvider` before `createAndSend`, `sendText` and an edit's send, and the adapter passes it as `billingEntitlement` to upstream `createSession`, `sendTurn` and `editSession`, which apply the free-plan 200-session and 30-turn quotas. A failed read sends `null`, the runtime's fail-open policy. A create refusal's `reason` is returned with `rejected`. `createTab` carries the same entitlement (a Tab is a session, so the 200-session quota applies as on Web); its refusal reason reaches the conversation's snackbar. It deliberately uses plain text (no shortcut, attachment or mention expansion). The snapshot's creation carries the public local-project `useWorktree` field. Native and JavaScript network gates permit only the exact workspace stream kinds needed for persistence and dispatch. An accepted Machine RPC is not task completion. GitHub branches are entered by name in this first integration.

Creation keeps cached choices visible until presence is known. The open creation
page refreshes from catalog/presence events, not a timer. Selecting an online provider revalidates its cached capabilities with `machine/acp-capabilities-refresh` through the
existing machine RPC transport, coalesced per provider/runtime; failed probes may retry on a later selection after a 30-second cooldown. Discovery is bounded
and serialized per machine. Its progress frames are not final replies; validated
final capabilities are held in a workspace/config-scoped display overlay and
passed through the normal capability projection. These capabilities are synchronized from the shared iOS runtime snapshot.

Creation reads healthy machine replicas independently: another machine's failed
sync does not block its agents or session creation. `creationOptionsChanged`
wakes both native pickers even before the whole catalog can report synced.
Matching `acpModelCapability` source versions supply per-model effort/Fast
controls; mismatched declarations never overwrite current capabilities. Below
them, each model's own option list recorded by a desktop or mobile model refresh
(`acpModelConfigOptions` pointers to shared `acpModelConfigOptionsShape` lists)
supplies that model's effort ladder and Fast toggle; `modelReasoningEfforts`
still wins over a record, and an unrecorded model keeps the snapshot.

Settings › Agents refreshes a provider (row menu or the editor's Refresh models
and modes) through `agentProviderProbe` with `readModelOptions`. The runtime sends
the field only to machines advertising `acpModelOptionsRead`, waits up to twenty
minutes, and emits `agentProviderRefreshProgress` naming each model. Save and test
remains the quick probe.

Agent discovery merges live `agent-*` repo metadata with machine Flock configs,
matching the daemon. Machine configs win by machine/config identity; deleted
metadata and agents outside readable healthy machines are excluded. Only display
fields reach native UI, never launch environments or credentials.

## Schedules

`schedule-commands.mjs` bridges the shared `schedules`, `scheduleDetail` and `scheduleCommand` calls with the native workspace identity. The dispatcher reduces thrown errors to one code, so schedule failures return in-band as `{error}`: the runtime's schedule codes pass through for localized copy, and any other write failure is `schedule_write_unknown`, because the write may have landed. Writes carry the caller's idempotency `requestId` and are never retried. Native waits up to 50 s for `schedules` and `scheduleDetail`, longer than the runtime's 40 s read budget, so the runtime's own outcome always arrives first. Both network gates allow `<workspace>:sr` (the Flock registry) and `<workspace>:schedule:<id>` (one schedule's Loro document) to be created, read and appended; deletes stay denied. The handler depends on `loro-mirror` 2.3.2, which shares the asynchronous Loro wrapper. It ships no license text, only `"license": "MIT"` in its package.json, so `build.mjs` accepts that declaration for this one reviewed package and records it in the license inventory.

## Operation receipts

The snapshot projects `operation_progress`, `operation_completion`, and
`operation_completion_batch` history items into `ItemSummary.operation` cards
and notices. Native `OperationEvents` consumes this display contract without
reinterpreting the durable receipt. Creation progress owns successful targets;
failure, cancellation, partial results and uncertain batch delivery remain visible.
The source commit is retained at `refs/heads/snapshot/mobile-operation-runtime`.
Its whole-package delta changes only `src/models/session.ts`,
`src/runtime/project.ts`, and `src/runtime/operation-presentation.ts`; dependency
versions and license files are unchanged. Android's bundled projection test uses
synthetic Loro history through `projectSession`, including reply text and a batch
with suppressed success plus an error.

## Agent settings

The current snapshot adds canonical provider list/save/delete/setup operations,
write-only advanced configuration, encrypted ACP authentication, binary operations,
Pi extension discovery, quota refresh and target invalidation events. Android keeps
its adapter and identity fencing outside the snapshot. Auth consent precedes opening
URLs; final method menus start a fresh flow, while resumable interactions retain their
flow. Native deadlines exceed the canonical 135-second probe, 60-second auth and
350-second operation limits. Provider setup remains daemon-owned until published.

MCP session selection remains supported. The upstream delta removes the unused
`memorySettings` contract and its two implementation files; Android has no consumer
and retains an explicit Memory placeholder. Dependencies and license files are unchanged.

## Settings caching and Agent Roles

The snapshot at `eff22abf` lets settings list reads keep an incremental per-runtime
stream cache (cleared on account or workspace change; callers get private copies, and
writes and turn-time Role reads still bootstrap fresh), lists `agentProviders` from the synced workspace
replicas with online and own computers first, loads prompt-shortcut indexes in
parallel, accepts a Role `emoji` on save and removes the project-history action.
`role-commands.mjs` bridges `agentRoleSettings` (list / save / delete) with the native
identity and a closed error vocabulary; both network gates permit read, create and
append of `<workspace>:wf:workspace` only. Prompt shortcuts: the contract bridge forwards
the runtime's allow-listed `shortcutCloud` host calls for the current workspace to native as
`shortcutCloud` events and answers each once through `shortcutCloudReply` (`{value}` or
null → `shortcut_unavailable`, 60-second native deadline); `shortcut-commands.mjs` bridges
`shortcutSettings` (list / read / save). Both gates permit read, create and append of
`shortcut-index:<workspace>:<owner>:<visibility>` and `shortcut-body:<id>`, whose
stream-specific tokens come from `getStreamToken`.

## Previews

The bridge forwards `sessionPreview`, `iosSimulatorControl` and `androidEmulatorControl` to the
snapshot unchanged, with the verified identity, and answers the runtime's `shareRequest`
`previewToken` host call through native (`previewToken` event, `previewTokenReply`); other
share-request operations stay unsupported. The network gates need no new streams: the preview calls
use the existing machine RPC request and response streams. See [Remote previews](rules/previews.md).

