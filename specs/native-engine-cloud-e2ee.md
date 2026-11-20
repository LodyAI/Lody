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

## Owner decisions

The owner gave these on 2026-11-20, and this document does not reopen them.

1. The native engine seals and opens encrypted content with the SDK keyring.
   Core may install keys into that keyring through one dedicated, narrow path,
   and it provides no general export.
2. Encrypted workspaces ship before plaintext cloud workspaces.

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

### 5. Encrypted workspaces: crypto in the engine keyring

By owner decision 1, the native engine seals and opens content itself, using
the SDK keyring (`LodyKeyringProtector`: LSCE v2, the `[3]`/`[4]` headers and
content-v0). It no longer calls core through a reverse RPC for each frame.

Core keeps everything else:

- ledger verification and pins;
- key receipt from the mailbox, installation and distribution;
- rotation and publication;
- recovery;
- machine-sharing checks.

**Engine and core responsibilities**

| Concern | Engine keyring | Lody core (main or daemon) |
| ------- | -------------- | -------------------------- |
| AEAD, signature, AAD and snapshot-offset checks on seal and open | yes | — |
| Which public keys may author content | uses the admitted set | supplies every historically admitted device key from the verified ledger |
| Whether this device may write now | refuses when no signer is installed or sealing is held | installs, holds or removes the signer by role and access |
| Which epoch new content uses | uses the seal epoch it is given | sets the verified current epoch, or the retained epoch during the 15-minute budget, then holds |
| Epoch keys | holds them in RAM only | owns the durable copies and decides what is installed |

The table splits current write permission from historical author admission.

- A revoked or removed member's device key stays admitted for opening. Its
  historical frames stay readable, as core requires.
- `revokeWriterPubkey` is used only on this device's own key, and only when that
  key must stop opening content too.
- Losing write permission (Guest, recovery device, role change, or an exhausted
  epoch budget) holds sealing without touching admission. That needs SDK
  primitive K2.

#### The install path (the only key-leaving route)

The only route by which key material leaves core is a new narrow core operation,
`installIntoEngineKeyring`. It hands material to the local engine and nowhere
else.

**What it installs, per encrypted namespace:**

- the pinned genesis;
- the verified epoch keys, excluding abandoned epochs;
- the seal epoch;
- every historically admitted device public key;
- this process's own writer signer, where the device may write.

The exact signer material is still an open question (open question 2).

**Who installs:**

- Electron main installs for the personal device, from
  [desktop custody](e2ee/desktop-custody.md).
- The daemon installs for its machine identity.
- Each binds its own writer id.
- A renderer never installs and never receives key material.

**When it installs:**

- after content-open admission and once a usable key is installed in core;
- an added epoch after it is genuinely committed and installed in core;
- newly admitted devices as the verified ledger advances;
- again after every reconnect, because the keyring does not persist and a host
  restart or build handoff starts empty.

Until material is installed, rooms report `protection_blocked`. They hold their
checkpoints, keep their local data and fall back to nothing.

**What core must guarantee on this path:**

- **A verified local connection only.** It sends only to a connection whose
  engine endpoint matches this installation's data directory and protocol, and
  only through the dedicated binary install request (K0). The key never travels
  through JSON, logs, IPC to a renderer or disk.
- **Exclusive source.** Material comes from `InstalledEpochKeys` through its
  existing borrow. Each copy is wiped with `acquireUseRelease` once the engine
  acknowledges, rejects or the connection fails.
- **No reuse of the route.** The operation is not a general export. It accepts
  only an engine-connection capability, and cannot be reached from product RPC,
  MCP or the renderer.

#### Rotation, removal and cleanup

**Rotation.** Core installs the new epoch, then moves the seal epoch to it.
Frames already sealed stay valid. Older epochs stay installed for reading
history. No remote pause is needed.

**Epoch abandonment.** An abandoned epoch (tag 11) is never installed, or is
removed from sealing if it already was.

**Removal of this device's access.** On credential-confirmed member removal or
revocation of this device, Lody:

1. writes a durable *pending wipe* marker beside the workspace's identity
   records;
2. calls `clearNamespace` to drop keys and admission;
3. removes the remote;
4. drops the namespace (E1), deleting the database and outbox.

A successful `dropNamespace` reply is the confirmation, and only that reply
clears the marker.

**If the host is down or unreachable during removal.**

- No key exists to clear, because the keyring never persists.
- The marker stays.
- On the next connect, before any other request for that namespace, Lody runs
  steps 2 to 4.
- Content-open admission refuses the namespace while the marker exists.
- If the wipe fails, the failure is reported and the marker retries on each
  connect. Nothing else is blocked.

**Removal of other members.** It changes only the seal-time write checks of the
removed members' own devices. Their historical frames stay readable.

#### Unchanged rules

These rules carry over unchanged:

- Sealing happens at upload, at the seal epoch current then.
- A device removed while offline never uploads its later edits.
- No remote is configured before authenticated mode classification. A
  contradicting answer retires the provisional plaintext namespace unsent.
- Room encryption policy is fixed at creation and fails closed.
- Snapshot upload keeps today's encrypted policy (S3).
- Keys still come from the verified ledger and the mailbox. Ledger, members,
  devices, [recovery](e2ee/recovery-vault.md) and
  [machine sharing](e2ee/machine-sharing.md) are unchanged.

#### Costs and mitigations

| Cost | Mitigation |
| ---- | ---------- |
| Keys gain a third holding process: the host, beside main and the daemon. | Install only into a verified local connection. Install the minimum (no abandoned epochs, no signer for read-only devices). Zeroize on clear, drop and exit. |
| Keys stay resident in host memory for the host's lifetime, which outlives windows. | `clearNamespace` when the workspace closes or access is lost. The host already exits when idle. Build handoff drains and zeroizes before releasing `files.lock`. |
| A host crash dump or swap can contain keys. | Disable core dumps for the host process, attach no crash reporter to it, and exclude it from minidump upload. Use `mlock` where the OS allows; this is best effort and stated as such. |
| JSON transport would leave base64 copies in the Node heap that cannot be wiped. | A binary install frame (K0). The Node side keeps only `Uint8Array` copies and wipes them. |
| A same-OS-user process can use the socket as a seal oracle, forging content as this device. | Writer-bound connections (K1, open question 1). |
| A second implementation of content crypto. | The phase 0 byte-equality suite against the real `@lody/e2ee-core` in both directions. |

#### Invariant amendment (draft; applied in implementation)

Core's rules say epoch keys have no public byte export, and keys/AGENTS.md says
never to add a generic secret export. Owner decision 1 approves one narrow
exception. The implementation PR amends both files as follows.

In `packages/e2ee-core/INVARIANTS.md`, after "Epoch keys have no public byte
export":

> The single exception is `installIntoEngineKeyring`. It copies verified epoch
> keys, and the caller's own writer signer where permitted, only into the local
> native engine keyring connection of the same installation, through its binary
> install request. It wipes every copy on every exit. It never writes, logs or
> returns material to callers, and it is not reachable from product RPC, MCP or
> renderers. The engine never becomes ledger authority. See
> `specs/native-engine-cloud-e2ee.md`.

In `packages/e2ee-core/src/internal/keys/AGENTS.md`, extend "Never add a generic
secret export …" with:

> except `installIntoEngineKeyring`, which borrows through
> `InstalledEpochKeys` like every other workflow.

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

**The engine socket.** The socket is mode 0600. It grants every connection
the full API, and the host now holds keys for as long as it runs.

Under an OS-user boundary alone, a process running as the same user can do two
things through the API:

- read plaintext, which it could already read from the local stores;
- seal arbitrary content as this device, which it cannot do today without
  extracting keys from custody.

It cannot read key bytes, because no request returns them.

Two mitigations were compared:

- **Writer-bound connections (K1).** Rows attributed to a writer are accepted
  only from the connection that installed that writer's signer. This closes the
  forgery oracle on every OS and is a small SDK change.
- **Authenticated connections.** A token in `engine.json` gains nothing against
  the same user. Real peer verification uses code signatures or peer
  credentials, and is platform specific.

Open question 1 asks which to require.

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
| K0 | E2EE | **Host-resident keyring over the socket.** Today `ContentKeyring` lives in the napi client process, and the host protocol has no install request. Draft: `keyringConfigure(ns, genesis)`, `keyringInstallEpoch(ns, epoch, key)`, `keyringSetSigner(ns, writer, seed)`, `keyringAdmit(ns, pubkeys)` and `keyringClear(ns)`. Key bytes travel in binary frames, never in JSON. The host zeroizes them on clear, drop, handoff and exit, and no request returns them. |
| K1 | E2EE | **Writer-bound connections.** A write attributed to writer W is accepted only from the connection that installed W's signer. When that connection closes, W's unsealed rows wait for a reinstall. |
| K2 | E2EE | **Seal policy separate from admission.** `keyringSetSealEpoch(ns, epoch)` replaces "highest installed epoch". Add `keyringHoldSealing(ns, writer)` / `release`, and `keyringRemoveSigner(ns, writer)`, which keeps the writer's public key admitted for opening. |
| S1 | cloud | Per-room live interest and pull: `setRoomInterest(ns, rooms, {live})` and `syncRooms(ns, rooms)`. Fix the binary Loro-update subscription so that it counts as interest. |
| S2 | cloud | The token reply carries `{token, expiresAt?, baseUrl?, bucket?, shardUrls?}`. Refresh the token before it expires. Encrypted content tokens last 8 minutes and carry their own bucket. |
| S3 | cloud, E2EE | Snapshot upload policy per remote: `{debounceMs, minBytes, maxBytes}`, a `canUploadSnapshot(ns, room)` reverse-RPC, and `uploadSnapshotNow(ns, room)` for repair requests. Snapshot bytes must match the legacy codec. |
| S4 | cloud | Remote imports are never rejected by a local `docSchema`; the schema applies only to local patches. Verify this first, and add the primitive only if it fails. |
| E1 | E2EE | `dropNamespace(ns)`: drain, close and durably delete a namespace's database and outbox. A durable reply confirms completion. |
| K3 | E2EE, if open question 2 is (b) or (c) | External signer: the engine encrypts and verifies in-engine, but asks the installing connection to sign each sealed frame. |
| N1 | — | Peer verification on the socket: code signature or peer credentials. Open question 1. |
| N2 | — | Streaming live transport (SSE or WebSocket) instead of long-poll. |

The npm releases must contain every primitive the shipping build uses. 0.1.0
predates most of them.

## Delivery plan

The line counts are rough Lody product-code estimates and exclude the SDK.
Encrypted workspaces ship first (owner decision 2).

| Phase | Scope | Acceptance | Rollback | Lines |
| ----- | ----- | ---------- | -------- | ----- |
| 0 | Prove format equality. Land K0–K2, S1–S4 and E1 in a release. | **Keyring and core equality**, against the real `@lody/e2ee-core`: frames sealed by the keyring open in core and the reverse; Loro and Flock updates and snapshots with continuation offsets; rotation (a new seal epoch, old-epoch frames still open); the retained-epoch budget, then a hold; abandoned epochs; authors revoked later still open; tampered AAD, document or epoch fail. **Recorded frames**: plaintext and encrypted, from the current product client and the server writers. | None needed. | ~500 (tests) |
| 1 | **Encrypted** workspaces on desktop and daemon, behind their own switch. Sync core (remotes after admission, token provider, live interest, legacy adoption, terminal drain), the install path, writer-bound connections, the pending-wipe cleanup, and renderer read gating. | Private E2E with a native device: persistence, snapshots, recovery, collaboration, the canary egress audit; layer-B `skew-convex-slow` (live rotation) and `transient-503`. Mixed native desktop and JS Web device. Host kill and build handoff with keys reinstalled. Removal with the host down, then wiped on the next connect. | Switch off: the legacy store re-syncs from the cloud and unuploaded rows are written back. | ~2200 |
| 2 | Plaintext cloud workspaces on the same core. | CLOUDSYNC-001 and the cloud journeys with native on; layer-B WAN profiles; W6 clock skew; switch off and on again. | Same as phase 1. | ~600 |
| 3 | Default on after soak, then remove the legacy desktop and daemon path. Web and mobile are unchanged. | Full `verify:release`. | Release revert. | net negative |

The private harness has no native device actor yet; phase 1 adds one.

## Open questions for the owner

1. **Hardening the engine socket now that the host holds keys.**

   *Background.* A process running as the same OS user can drive the full API.
   It can already read local plaintext, and it cannot read key bytes. What is
   new is that it can seal content signed as this device.

   *Options.*
   - **(a)** The OS user as the only boundary. This costs nothing, but leaves
     the forgery oracle.
   - **(b)** Writer-bound connections (K1). This is a small SDK change, closes
     the oracle on every OS and adds no platform work. Plaintext reads stay at
     the OS-user boundary.
   - **(c)** (b) plus peer verification (N1). This is per-OS work. It is
     effective on macOS and Windows and weak on Linux.

   *Recommendation.* (b), as a phase 1 blocker. (c) follows later and does not
   block.

2. **Whether the device signing seed enters the engine.**

   *Background.* The content signer is the device's Ed25519 identity key. On
   Owner/Admin devices the same key signs ledger governance records. Domain
   separation stops the engine API from producing ledger signatures. A leaked
   seed, however, from a crash dump or memory, lets an attacker forge governance
   as that device. Epoch keys alone only expose content.

   *Options.*
   - **(a)** Install the seed. Everything runs in the engine, with no reverse
     RPC.
   - **(b)** Keep signing in custody (K3). Only seals make a signing round trip.
     Opens, the hot path during catch-up, stay entirely in the engine.
   - **(c)** Install seeds only for machine identities, which sign no
     governance, and use (b) on personal devices.

   *Recommendation.* (c). Local writes are batched, so a signing round trip per
   seal is cheap. Personal identity keys then stay in custody.

## Evidence

- **Intent.**
  - Owner direction relayed on 2026-11-20: E2EE-first, Roost as default, local
    permission checks, no format change, availability first.
  - Owner decisions 1 (crypto in the engine keyring, with a narrow core install
    exception) and 2 (encrypted workspaces first), given by the owner in the
    coordinating session on 2026-11-20 and recorded on
    [#2955](https://github.com/LodyAI/Lody/pull/2955).
  - This revision is not approved.
- **Inspected.**
  - The native stack: draft PRs #2902–#2942 (top `native-desktop-acceptance-fixes`
    @ `840f6d05`) and its design doc `.agents/docs/native-workspace-meta.md`.
  - loro-dev/loro-repo `main` @ `ad97aa3`:
    - `rust/packages/client`: remote, protector, auth and status types;
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
