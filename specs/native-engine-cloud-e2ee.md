# Cloud sync and encrypted workspaces on the native engine

Status: draft
Translation: current

[中文](native-engine-cloud-e2ee.zh.md)

On the desktop and the daemon, local workspaces can already use the native
loro-repo-rs engine for Workspace Meta, the `wf`/`mf`/`sr` Flock tables and the
Session, `schedule-*` and Preview comment Loro documents. That path is behind a
default-off switch. Cloud and encrypted (E2EE) workspaces still use the legacy
JS loro-repo path.

A user who signs in on that desktop expects their cloud and encrypted
workspaces to behave as they do today. Their phone, the Web app and older
desktops keep working in the same workspace. The server never sees plaintext.

This Spec decides how the native engine joins those workspaces. It is a design
only and changes no product code.

## Decisions

### 1. Same streams, same bytes; no cloud migration

Native rooms sync to the **existing Loro Streams streams in the existing
formats**:

- the same bucket, the same `<workspaceId>:meta`, `:s:`, `:schedule:`, `:pc:`,
  `:wf:`, `:mf:` and `:sr` stream ids (the SDK's Lody route table);
- length-prefixed update appends, the shared snapshot codec and HEAD/bootstrap
  catch-up;
- for encrypted workspaces, LSCE v2 with provider headers `[3]`/`[4]`, the
  loro-repo room AAD wrapper over namespace `lody-e2ee:<genesis>`, and
  content-v0 frames.

No existing wire or persisted format changes. Nothing in this design requires
one. Because the formats match:

- **Cloud data is not migrated.** Old and new clients write the same streams,
  and convergence is the ordinary Loro/Flock merge it is today.
- **Old and new clients share a workspace without new rules.** That covers
  legacy desktop, Web, the mobile webview, and the server-side writers for
  session bootstrap, submissions and PR webhooks.
- **A native client adopts the legacy store on first use.** It adopts the
  installation's legacy local store through the
  [workspace bundle](workspace-export-import.md#native-migration)
  `legacy-repo` source adapter. Raw room bytes and the stream checkpoint move
  together, and edits that were never uploaded are queued for upload under
  their original writer.

The native engine's own local storage has no released data, so it keeps no
compatibility layer for its own earlier formats.

Format equality is a precondition, not an assumption. Phase 0 proves it with
recorded frames from the current product client and the server writers, not
with the SDK's own reimplementation.

If the SDK ever needs to differ, for example in snapshot compression, it must
add an option that reproduces the legacy bytes. The format itself does not
change.

### 2. One local owner per device; cloud is only in the cloud composition

The native host stays one process per platform data directory, held by
`files.lock`. The daemon and Electron main each hold a connection. A device
therefore has one replica per room, and the renderer↔daemon local data plane is
not needed for native rooms.

Remotes, token providers and protectors are registered only by the cloud
composition, after workspace admission. The OSS desktop never configures a
remote and makes no cloud request.

Remote configuration may persist, but tokens stay in RAM. A host restarted with
no token provider stops at `auth_required`. A host with no protector stops at
`protection_blocked`. Neither state sends anything.

### 3. What stays live

These rooms are always live while their workspace is open:

- Meta;
- the `wf`, `mf` and `sr` catalogs.

A Session, schedule or Preview comment room is live while a renderer view or a
daemon replica has it open. Any other room is pulled when it is opened.

The daemon learns of new remote input through the Meta and machine rooms it
already watches, as it does today.

Live interest must be per room. A whole-namespace pass over thousands of
Session rooms is not acceptable on a user path. This needs an SDK primitive
(S1).

### 4. Offline, reconnect and terminal boundaries

**Offline and reconnect.**

- A local commit is accepted once it is durable in the engine.
- The SDK outbox keeps it until the server acknowledges it.
- Sealed rows are re-sent byte for byte, never sealed again.
- Pull checkpoints advance only after the imported state is durable.
- After the server trims history (48 h after a snapshot), a `410` re-bootstraps
  from the snapshot.

This keeps the
[runtime lifecycle](workspace-runtime-lifecycle.md) guarantee: committed
offline edits survive close, and close does not wait for upload.

**Terminal boundaries.** Quit, sign-out and workspace deletion follow
[failure containment](../.agents/docs/failure-containment.md):

- give the outbox drain a bounded deadline;
- report rows still pending;
- terminate.

The pending rows stay in the engine's durable outbox and upload on the next
start.

**Turning native off.** Turning native off for a cloud workspace is safe. The cloud already holds
everything that was uploaded. The legacy store catches up from the cloud. The
existing write-back hands the legacy store only the rows that were never
uploaded, so the legacy path uploads them.

### 5. Encrypted workspaces: crypto stays in custody

The engine stores and replicates. It never holds epoch keys, device keys or
ledger authority.

**Who seals and opens.** Sealing and opening run in `@lody/e2ee-core` through
the SDK's protector reverse-RPC:

- Electron main registers for its personal device, through
  [desktop custody](e2ee/desktop-custody.md).
- The daemon registers for its machine identity.
- Each registers with its **exact writer ids**. Every outbox row carries its
  writer, and only that writer's protector may seal it.

A renderer write goes through main. It is therefore attributed to and sealed by
the personal device; the daemon's own writes are sealed by the machine.

**Which checks run.** Every existing check runs unchanged in core:

- current write permission is checked before encryption and again after
  signing;
- the current epoch is used, with the 15-minute retained-epoch budget;
- authors must be historically admitted;
- snapshots are signed by their producer at its continuation offset;
- there is no plaintext fallback.

The SDK's in-engine `ContentKeyring` is for tests only.

**When rows are sealed.** Sealing happens at upload time, not at commit time.
An offline edit is sealed when the device reconnects, at the epoch current at
that moment and under that moment's write permission.

A device removed while offline therefore never uploads its later edits. Its
local copy follows the existing access-loss handling.

**Keys, ledger, members, devices, recovery and machine sharing are unchanged.**

- Keys still come from the verified ledger and the mailbox.
- Rotation and removal follow the [atomic removal](e2ee/atomic-removal.md) rules.
- [Recovery](e2ee/recovery-vault.md) installs keys through core.
- [Machine sharing](e2ee/machine-sharing.md) still checks execution in the
  daemon.

The engine notices none of these.

**Rotation.** Rotation needs no engine pause. The next seal uses the new epoch,
and frames already sealed remain valid.

**Removal and revocation.** Credential-confirmed member removal or device
revocation does four things:

- unregisters the protector;
- removes the remote;
- drops the namespace through a new durable SDK primitive (E1);
- removes the workspace's local plaintext, as the whitepaper requires.

**Mode admission.** The existing [mode admission](../packages/platform/AGENTS.md#e2ee-workspace-control)
applies to the engine namespace:

- No remote is configured before authenticated classification.
- A workspace with encrypted evidence opens nothing before content-open
  admission.
- If the answer is encrypted or contradictory, the provisional plaintext
  namespace is retired and never uploaded, exactly as the provisional Repo is
  today.
- An engine room's encryption policy is fixed when it is created, and a room
  that does not match its remote is refused. A mismatch therefore fails closed.

**Snapshot upload.** Snapshot upload keeps today's encrypted policy:

- only write-capable devices upload;
- uploads wait for 30 s of idle and at least 1 MiB of new bytes, and are forced
  at 4 MiB;
- uploads stop while the device is closed, has lost access, or is in an epoch
  phase.

This needs an SDK hook (S3).

### 6. Plaintext stays on the device; new surfaces

Ciphertext is all that leaves the device: updates, snapshots and Flock bundles
are sealed before upload. Presence keeps its approved allowlist on its separate
channel.

**At rest.** Local engine storage is plaintext, as the legacy stores are.
[Whitepaper §1.2](e2ee/whitepaper.md#12-scope-and-assumptions) keeps local
content in existing storage, so this is not a new at-rest exposure.

The design adds two local surfaces.

**Renderer remote reads.** Plaintext now reaches the renderer by paged IPC
instead of a replica. Main must check every request:

- **Workspace scope.** The namespace must be the renderer's currently admitted
  workspace.
- **Session read access.** A Session is readable only under the existing
  [session read rules](session-access.md). Cloud workspaces contain other
  members' private Sessions, so the local-only single-workspace check is not
  enough.
- **Access loss.** On access loss, every view in that namespace closes and late
  replies are discarded.
- **Writes.** Write authorization is unchanged: `humanInputReceipts` is stamped
  only for the current local user, and signed execution intents stay in main.

The renderer holds less plaintext than it does today, but it must not be able
to name an arbitrary room.

**The engine socket.** The socket is mode 0600 but grants every connection the
full API, including registering protectors and configuring remotes. Any process
running as the same OS user can already read the plaintext stores. The design
therefore treats the OS user as the boundary, the same as today.

The difference is that the socket is a live API rather than files. Open
question 1 asks whether to accept that.

**Logs and diagnostics.** Engine errors and diagnostics must not carry
plaintext.

### 7. Roost

Roost and native cloud sync **coexist**; neither migrates into the other in
this design.

Roost history stays with its owner machine and is read through owner
subscription and RPC. Native Streams rooms carry Meta, catalogs and the Session
control document. LSCE does not cover Roost streams. The engine's own RoostStream
rooms are not used by Lody here.

Session read authority is backend independent. When Roost becomes the default
history backend, and when E2EE gains Roost, both use the same
[session read admission](session-access.md). This design adds no
backend-specific grant.

### 8. Web and the mobile webview

Browsers have no native engine. Web and the mobile webview keep the JS
loro-repo, streams-crdt and IndexedDB stack with `@lody/e2ee-client`.

They interoperate with native desktops only because the wire formats are
identical (decision 1). That is why format equality is a release gate.

A WASM build of the engine is not part of this design.

## SDK primitives

They are ordered by what they block. The names are drafts. The SDK stays free
of Lody domain concepts.

| ID | Blocks | Primitive (draft) |
| -- | ------ | ----------------- |
| S1 | cloud | Per-room live interest and pull: `setRoomInterest(ns, rooms, {live})` and `syncRooms(ns, rooms)`. Fix the binary Loro-update subscription so that it counts as interest. |
| S2 | cloud | The token reply carries `{token, expiresAt?, baseUrl?, bucket?, shardUrls?}`. Refresh the token before it expires. Encrypted content tokens last 8 minutes and carry their own bucket. |
| S3 | cloud, E2EE | Snapshot upload policy per remote: `{debounceMs, minBytes, maxBytes}` plus a `canUploadSnapshot(ns, room)` reverse-RPC. Snapshot bytes must match the legacy codec. |
| S4 | cloud | Remote imports are never rejected by a local `docSchema`. The schema applies only to local patches. Verify this first, and add the primitive only if it fails. |
| E1 | E2EE | `dropNamespace(ns)`: drain, close and durably delete a namespace's database and outbox. |
| E2 | E2EE | Writer-exact protector routing: a row tagged with a writer never falls back to a `*` protector. Verify and test; the API already carries `writers`. |
| N1 | — | Per-connection scopes on the socket (namespaces, read-only). Needed only if open question 1 is answered "harden". |
| N2 | — | Streaming live transport (SSE or WebSocket) instead of long-poll. |

The npm releases must contain every primitive the shipping build uses. 0.1.0
predates most of them.

## Delivery plan

The line counts are rough Lody product-code estimates and exclude the SDK.

| Phase | Scope | Acceptance | Rollback | Lines |
| ----- | ----- | ---------- | -------- | ----- |
| 0 | Prove format equality. Land S1–S4, E1 and E2 in a release. | Interop vectors in both directions: plaintext and encrypted updates, snapshots, Flock bundles, server-written frames. | None needed. | ~300 (tests) |
| 1 | Sync core in the cloud composition: remotes after admission, token provider, live interest, legacy adoption, terminal drain. Run first on **encrypted** workspaces (open question 2), with a separate switch. | Private E2E with a native device: persistence, snapshots, recovery, collaboration, the canary egress audit; layer-B `skew-convex-slow` and `transient-503`. Mixed native desktop and JS Web device. | Switch off: the legacy store re-syncs from the cloud and unuploaded rows are written back. | ~1800 |
| 2 | Plaintext cloud workspaces on the same core. | CLOUDSYNC-001 and the cloud journeys with native on; layer-B WAN profiles; W6 clock skew; switch off and on again. | Same as phase 1. | ~600 |
| 3 | Default on after soak, then remove the legacy desktop and daemon path. Web and mobile are unchanged. | Full `verify:release`. | Release revert. | net negative |

The order of phases 1 and 2 is open question 2. The private harness has no
native device actor yet; phase 1 adds one.

## Open questions for the owner

1. **The engine socket in encrypted workspaces.** Background: any process
   running as the same OS user can drive the host's full API, including
   registering a higher-priority protector to observe plaintext. It can already
   read the plaintext files. The options:
   - **(a)** Accept the OS user as the boundary, as today. This costs nothing.
   - **(b)** Add per-connection scopes (N1) and connection authentication. This
     is SDK work and delays phase 1.

   Recommendation: (a) for this design, revisited with the whitepaper's
   local-connection protection item.

2. **Ship order.** Background: encrypted workspaces have no production data and
   are the future default. Plaintext cloud workspaces carry existing users. The
   options:
   - **(a)** Encrypted first. It has the smallest blast radius and exercises the
     E2EE-first design.
   - **(b)** Plaintext first. It is simpler, but the first users of the new path
     are production users.

   Recommendation: (a).

3. **Where content crypto runs.** Background: the SDK offers an in-engine Rust
   keyring. Using it would remove the reverse-RPC hop, but custody would then
   have to export epoch keys into the engine process. Core forbids that export,
   and every core check would need a second implementation. The options:
   - **(a)** Keep core in the custody processes (decision 5).
   - **(b)** Use the Rust keyring.

   Recommendation: (a). Measure reverse-RPC cost in phase 0.

## Evidence

- **Intent.** Owner direction relayed by the coordinating session on
  2026-11-20: E2EE-first, Roost as default, local permission checks, no format
  change, availability first. This revision is not approved.
- **Inspected.**
  - The native stack: draft PRs #2902–#2942 (top `native-desktop-acceptance-fixes`
    @ `840f6d05`) and its design doc `.agents/docs/native-workspace-meta.md`.
  - loro-dev/loro-repo `main` @ `ad97aa3`: `rust/packages/client` (remote,
    protector, auth and status types), `rust/docs/architecture.md` and the
    `lody-routes` table.
  - [Workspace Streams content](workspace-streams-content.md),
    [E2EE foundations](e2ee-foundations.md), [whitepaper](e2ee/whitepaper.md),
    [platform E2EE rules](../packages/platform/AGENTS.md#e2ee-workspace-control),
    [core invariants](../packages/e2ee-core/INVARIANTS.md),
    [client rules](../packages/e2ee-client/AGENTS.md) and the
    [bootstrap guide](../.agents/docs/e2ee-workspace-bootstrap.md).
- **Not executed.** Nothing has been run. Byte equality with `@lody/e2ee-core`
  is tested inside the SDK only against its own content-v0 reimplementation.
  Phase 0 closes that gap.
- **Backend.** Backend-specific details are in the private repository's design
  document.
