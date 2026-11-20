# Cloud sync and encrypted workspaces on the native engine

Status: approved · [approval](https://github.com/LodyAI/Lody/pull/2955#issuecomment-7028570219)
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

## Owner decisions

The owner gave these on 2026-11-20, and this document does not reopen them.

1. The engine seals, signs and opens encrypted content with the SDK keyring.
   Core installs keys and the device signing seed into it through one dedicated
   path, and provides no general export. The data process is trusted, so an
   extra holder is acceptable.
2. Encrypted workspaces ship before plaintext cloud workspaces.
3. Writer-bound connections (K1) are a phase 1 prerequisite. Peer-process
   verification is not planned.
4. Keep the design minimal:
   - the data process alone owns storage, sync and crypto;
   - main and the daemon hand it keys and keep them current;
   - the renderer only reads plaintext through main and never touches keys.

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

Remotes, token providers and keyring material are installed only by the cloud
composition, after workspace admission. The OSS desktop never configures a
remote and makes no cloud request.

Remote configuration may persist, but tokens stay in RAM. A host restarted with
no token provider stops at `auth_required`. A host with no installed keys stops at
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

### 5. Encrypted workspaces: the engine does the crypto

The engine seals, signs and opens content itself, using the SDK keyring
(`LodyKeyringProtector`: LSCE v2, the `[3]`/`[4]` headers and content-v0). No
crypto reverse RPC remains.

Core in main and the daemon keeps every authority decision: ledger
verification, key receipt and distribution, rotation, recovery and machine
sharing. It only hands the engine the material to act on, and it updates that
material when its state changes.

**What is installed.** For each encrypted namespace:

- the pinned genesis;
- the verified epoch keys, excluding abandoned epochs;
- the seal epoch;
- every historically admitted device public key;
- this process's writer signing seed, if the device may write.

**Who installs.** Electron main installs for the personal device and the daemon
for its machine identity. A renderer never installs anything and never
receives key material.

**Notifications.** Each trigger has one owner, and each owner pushes one thing:

| Trigger | Who pushes | What the engine receives |
| ------- | ---------- | ------------------------ |
| Content-open admission, with a usable key in core | main or daemon | full install |
| New epoch committed and installed in core | the same | install that epoch, then move the seal epoch to it |
| Ledger advances or a new device is admitted | the same | admit the new public keys |
| This device loses write permission (Guest, role change, exhausted 15-minute epoch budget) | the same | hold sealing and snapshot upload for its writer; admission and older epochs stay |
| This device's member is removed or the device is revoked | the same | clear the keyring, remove the remote, drop the namespace |
| The host restarts, reconnects or hands off to a new build | the same, on reconnect | full reinstall (the keyring never persists) |

A revoked or removed member's public key stays admitted, so their historical
frames stay readable as core requires. Rows written before keys arrive wait in
`protection_blocked` and fall back to nothing.

**Why it does not leak to other applications.**

- **Write only.** No engine request returns key material. The engine exposes
  content sealing and opening, never a general signing call.
- **Same-user access only.** The socket and `engine.json` are mode 0600 in the
  user's data directory.
- **One channel.** Keys travel only from main or the daemon to the engine, in
  binary frames. They never pass through a renderer, disk, JSON or logs.
- **Writer-bound connections (K1).** Only the connection that installed a
  writer's seed can seal content as that writer. Another local process has no
  seed to install and cannot use one installed by someone else.

**Accepted cost.** The host is a third process holding keys and device seeds in
memory. The owner accepts this because the data process is trusted and managed
by Lody. Its one mitigation is that the host process disables core dumps and
attaches no crash reporter.

**Removal and cleanup.** On credential-confirmed member removal or revocation
of this device, Lody:

1. writes a durable *pending wipe* marker beside the workspace's identity
   records;
2. clears the keyring;
3. removes the remote;
4. drops the namespace (E1).

A successful `dropNamespace` reply is the confirmation, and only that reply
clears the marker.

If the host is down at that moment, there are no keys to clear, because the
keyring never persists. On the next connect, Lody finishes steps 2 to 4 before
any other request for that namespace. While the marker exists, content-open
admission refuses the namespace. A failed wipe is reported and retried; it
blocks nothing else.

**Unchanged rules.**

- Content is sealed at upload with the seal epoch in force at that moment, so a
  device removed while offline never uploads its later edits.
- No remote is configured before authenticated mode classification. A
  contradicting answer retires the provisional plaintext namespace unsent.
- Room encryption policy is fixed at creation.
- Snapshot upload keeps today's encrypted policy (S3).
- Ledger, members, devices, [recovery](e2ee/recovery-vault.md) and
  [machine sharing](e2ee/machine-sharing.md) are unchanged.

**Invariant amendment** (drafted here and applied in the implementation PR;
approved by owner decision 1).

`packages/e2ee-core/INVARIANTS.md`, after "Epoch keys have no public byte
export":

> The single exception is `installIntoEngineKeyring`. It copies verified epoch
> keys, admitted public keys and the caller's own writer seed only into the
> local native engine connection of the same installation, in binary install
> frames. It wipes every copy afterwards. The engine exposes content sealing
> and opening only: it never signs ledger or governance records, never returns
> key material, and never becomes ledger authority.

`packages/e2ee-core/src/internal/keys/AGENTS.md`, extend "Never add a generic
secret export …" with:

> except `installIntoEngineKeyring`, which borrows through
> `InstalledEpochKeys`.

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

**The engine socket.** It is covered by section 5: it is write-only for keys,
same-user only, and writer-bound.

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
identical (section 1). That is why format equality is a release gate.

A WASM build of the engine is not part of this design.

## SDK primitives

They are ordered by what they block. The names are drafts. The SDK stays free
of Lody domain concepts.

| ID | Blocks | Primitive (draft) |
| -- | ------ | ----------------- |
| K0 | E2EE | **Host-resident keyring.** Today `ContentKeyring` runs in the napi client process, and the host protocol has no install request. Add install requests in binary frames: `keyringConfigure(ns, genesis)`, `keyringInstallEpoch`, `keyringSetSigner(ns, writer, seed)`, `keyringAdmit` and `keyringClear`. The host zeroizes on clear, drop, handoff and exit, and no request returns key material. |
| K1 | E2EE | **Writer-bound connections.** Only the connection that installed writer W's seed may write or seal as W. |
| K2 | E2EE | **Seal policy separate from admission:** `keyringSetSealEpoch(ns, epoch)` and `keyringHoldSealing(ns, writer)` / `release`. A hold keeps admission and older epochs, unlike `revokeWriterPubkey`. |
| S1 | cloud | Per-room live interest and pull: `setRoomInterest(ns, rooms, {live})` and `syncRooms(ns, rooms)`. Fix the binary Loro-update subscription so that it counts as interest. |
| S2 | cloud | The token reply carries `{token, expiresAt?, baseUrl?, bucket?, shardUrls?}`. Refresh the token before it expires. Encrypted content tokens last 8 minutes and carry their own bucket. |
| S3 | cloud, E2EE | Snapshot upload policy per remote: `{debounceMs, minBytes, maxBytes}`, a pushed `setSnapshotUpload(ns, allowed)` gate, and `uploadSnapshotNow(ns, room)` for repair requests. Snapshot bytes must match the legacy codec. |
| S4 | cloud | Remote imports are never rejected by a local `docSchema`. Verify this first; add the primitive only if it fails. |
| E1 | E2EE | `dropNamespace(ns)`: drain, close and durably delete a namespace's database and outbox. A durable reply confirms completion. |
| N2 | — | Streaming live transport (SSE or WebSocket) instead of long-poll. |

The npm releases must contain every primitive the shipping build uses. 0.1.0
predates most of them.

## Delivery plan

The line counts are rough Lody product-code estimates and exclude the SDK.
Encrypted workspaces ship first (owner decision 2).

| Phase | Scope | Acceptance | Rollback | Lines |
| ----- | ----- | ---------- | -------- | ----- |
| 0 | Prove format equality. Land K0–K2, S1–S4 and E1 in a release. | Keyring frames open in the real `@lody/e2ee-core`, and core frames open in the keyring. Coverage: Loro and Flock updates and snapshots, rotation with old-epoch reads, held sealing, authors revoked later, and tampered AAD, document or epoch. Recorded plaintext and encrypted frames from the product client and the server writers. | None needed. | ~400 (tests) |
| 1 | **Encrypted** workspaces on desktop and daemon, behind their own switch: the sync core (remotes after admission, token provider, live interest, legacy adoption, terminal drain), the install and notification table, pending-wipe cleanup, and renderer read gating. | Private E2E with a native device: persistence, snapshots, recovery, collaboration, the canary egress audit; layer-B `skew-convex-slow` (live rotation) and `transient-503`. A mixed native desktop and JS Web device. Host kill and handoff with reinstall. Removal while the host is down. | Switch off: the legacy store re-syncs from the cloud and unuploaded rows are written back. | ~1700 |
| 2 | Plaintext cloud workspaces on the same core. | CLOUDSYNC-001 and the cloud journeys with native on; layer-B WAN profiles; W6 clock skew; switch off and on again. | Same as phase 1. | ~500 |
| 3 | Default on after soak, then remove the legacy desktop and daemon path. Web and mobile are unchanged. | Full `verify:release`. | Release revert. | net negative |

The private harness has no native device actor yet; phase 1 adds one.

## Open questions for the owner

None.

## Evidence

- **Intent.**
  - Owner direction relayed on 2026-11-20: E2EE-first, Roost as default, local
    permission checks, no format change, availability first.
  - Owner decisions 1–4 given in the coordinating session on 2026-11-20 and
    recorded on [#2955](https://github.com/LodyAI/Lody/pull/2955).
  - The owner approved this revision (`f4bd8d1c0`) on 2026-11-20 ([record](https://github.com/LodyAI/Lody/pull/2955#issuecomment-7028570219)).
- **Inspected.**
  - The native stack: draft PRs #2902–#2942 (top `native-desktop-acceptance-fixes`
    @ `840f6d05`) and its design doc `.agents/docs/native-workspace-meta.md`.
  - loro-dev/loro-repo `main` @ `ad97aa3`:
    - `rust/packages/client`: remote, auth and status types;
    - `rust/npm/engine`: `ContentKeyring`;
    - `rust/crates/loro-repo-types`: there is no keyring request;
    - `rust/docs/architecture.md` and the `lody-routes` table.
  - Lody: [Workspace Streams content](workspace-streams-content.md),
    [E2EE foundations](e2ee-foundations.md), [whitepaper](e2ee/whitepaper.md),
    [platform E2EE rules](../packages/platform/AGENTS.md#e2ee-workspace-control),
    [core invariants](../packages/e2ee-core/INVARIANTS.md),
    [key rules](../packages/e2ee-core/src/internal/keys/AGENTS.md),
    [client rules](../packages/e2ee-client/AGENTS.md) and the
    [bootstrap guide](../.agents/docs/e2ee-workspace-bootstrap.md).
- **Not executed.** Nothing has been run. The keyring's equality with core is
  tested inside the SDK only against its own content-v0 reimplementation. Phase
  0 replaces that with the real core package.
- **Backend.** Backend-specific details are in the private repository's design
  document.
