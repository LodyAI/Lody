# Content-addressed remote diff transport

Status: proposed
Translation: current

[中文](2026-10-31-remote-diff-transport.zh.md)

## Abstract

Remote clients (web, mobile, a desktop viewing another machine) read diffs by asking
the owning daemon for the full old and new text of a file:

- every open re-sends both texts;
- any file-index change re-fetches the whole All Changes batch;
- budgets ignore the RPC envelope's own encoding;
- in encrypted workspaces, a read-only member can open file text but not a diff.

The proposal splits every diff into two parts. The first is a paged manifest of
paths, stats, blob keys and opaque per-file generations. The second is a set of
immutable blobs, read by byte range from three defined sources and cached on the
client. Both new methods are pure reads, and files too large for remote get a
hunk-only payload. Offline viewing, meaning diff bodies persisted off the machine,
is out of scope. Nothing here is implemented or measured; the byte savings are
expected, not observed.

## Problem

Current behavior was inspected at `d07ea674c` and re-checked against the working
tree on 2026-11-01:

- `code-collab/open-current-diff`, `open-turn-diff` and `open-all-changes-diff`
  return `CodeCollabV2DiffSnapshot` texts (`packages/shared/src/code-collab.ts`).
  - Texts up to 64 KiB are sent plain; larger texts are gzip-base64.
  - Each text is capped at 1 MiB compressed.
  - No digest travels with them, so the client cannot reuse a text it already
    holds.
- The base side (git merge-base or HEAD blob, or the turn's old snapshot) is
  immutable, but it is re-sent on every open and every refresh.
- The client subscribes to the `fi:` file-index Flock.
  - Any row change produces a new `CodeCollabSessionFileProvider`.
  - `use-session-all-changes-diff-data.ts` treats that as stale and re-requests the
    entire batch.
- All Changes mode first requests a whole `open-all-changes-diff` batch.
  - Viewport gating (`use-diff-viewport.ts`) applies only to its `deferred`
    entries.
  - Session and turn modes already load per file through `loadPaths`.
- `CODE_COLLAB_V2_ALL_CHANGES_DIFF_LIMITS` count the payload's own base64:
  `encodedDiffSnapshotWireBytes` uses `payload.data.length`. They do not count the
  AES-GCM owner-session envelope around it, or JSON overhead.
- Electron reaches the same service through the local `/machine-rpc` fast path. It
  inherits the 1 MiB and batch caps, which exist only for the Streams path.
- Client caches are in memory only:
  - the 96-entry parsed-diff LRU in `diff-viewer.tsx`;
  - the 8-entry `resolvedDiffCache` in `use-session-conversation-diff-data.ts`.
- In encrypted workspaces, `E2EE_READ_QUERY_METHODS`
  (`packages/shared/src/e2ee-rpc.ts`) contains `code-collab/open-text`,
  `refresh-text` and `file/download-chunk`. None of the `open-*-diff` methods is in
  it.
  - Every diff call therefore needs write access and goes through the execution
    journal's claim / retain / finish.
  - A read-only member can read file bodies but not diffs.
  - This is not explained by the watch: `openText` also calls
    `ensureWorkspaceWatch`, yet it is authorized as a read.

## Prior art

Read in source unless marked otherwise.

- **Zed** sends only base texts (`UpdateDiffBases`, `OpenUncommittedDiff`). It
  fetches branch blobs by git oid, 16 reads at a time. The client computes the diff,
  and the host pushes only the bases that changed.
- **Paseo** pushes a full pre-tokenized hunk snapshot on every change and runs into
  its relay frame budget. Its own comment reads: "temporary until diffs load lazily
  per file".
- **Orca** pulls full old/new text per file, like Lody does today. It caps only
  remote callers (4 MiB per reply, measured after JSON escaping) and leaves local
  calls uncapped.
- **Happy** pulls `git diff` patches over its E2EE RPC.
- **GitHub** (from its documentation) loads small files automatically and puts files
  above 400 lines or 20 KB behind "Load diff".

None of the products that read diffs from a live repository shows them while the
host is offline. Only products that persist diffs on a server (GitHub, Codex cloud)
do.

## Proposal

### 1. Manifest

A new owner-scoped method, `code-collab/open-diff-manifest`.

**Request**

The request takes today's scope inputs plus paging:

- the scope, which is one of:
  - `sessionId` plus `turnId`;
  - `sessionId` plus the All Changes scope `branch` / `uncommitted`;
  - `sessionId` plus a single `path`;
- `cursor?`, an opaque string;
- `limit?`, a path count, which the daemon clamps.

**File set**

The file set matches today's change set and never lists the whole workspace:

- turn scope: the turn's recorded files;
- All Changes: the changed paths under the scope's base, across project members;
- single path: exactly one entry. This is the only case that may return
  `not_changed`.

**Response and paging**

The response is `{ entries, nextCursor: string | null }`.

- The cursor is bound to the scope and to each member's resolved base.
- If a base moves between pages, the next page fails with `stale`, and the client
  restarts from the first page.
- Entries follow today's All Changes order: the focus path first, then the smallest
  change first.

**Entry fields**

| Field | Contents |
| --- | --- |
| `path` | The file path, plus the previous path for a rename |
| `add`, `del` | Line counts |
| `status` | `ok`, `binary`, `missing`, `too_large` or `not_changed` |
| `base`, `head` | Each side is `null` for a created or deleted file, or `{ key, rawBytes, format }` |
| `version` | The generation token published in the file index (section 4) |
| `hunks` | Optional (section 5) |

`format` is the existing `CodeCollabV2TextFormat`, which records BOM and line
endings. It describes the decoded text and is never a transport encoding.

**Blob keys**

- `git:<oid>` keys a git base side.
  - The oid is 40 hex characters in a SHA-1 repository and 64 in a SHA-256
    repository.
  - The client picks the verification algorithm from the oid's length and hashes
    `blob <len>\0<bytes>`.
  - The daemon resolves the oid with `git rev-parse <base>:<path>` in that member's
    own repository and base, as `resolveCurrentDiffBaseSnapshot` does through
    `projectRun`. It never resolves the oid against the session root.
- `sha256:<hex>` keys current disk text and turn snapshots. It is validated by the
  existing `CodeCollabV2FileDigestSchema`.

**Size cap**

Remote uses the same per-side cap as local: `maxRawTextBytes`, 10 MiB raw. A side
over the cap makes the entry `too_large`. Such an entry carries stats only, with no
keys and no hunks, so nothing can expand it into the renderer.

**Loading by viewport**

The manifest carries no file text, so it replaces the batched body response and its
2 MiB budget. Today the All Changes path of `use-session-all-changes-diff-data.ts`
batch-loads everything and gates only the `deferred` entries. It changes to:

1. request manifest pages;
2. read blobs only for the entries the viewport reaches.

### 2. Blob reads

A second method, `code-collab/read-blob`.

**Request and response**

- The request is `{ sessionId, key, offset, length }`. Both `offset` and `length`
  are byte positions in the raw blob.
- The response is `{ offset, length, totalBytes, encoding: 'gzip-base64', data }`.
  - `data` is the raw bytes gzipped, then base64-encoded.
  - `length` is the length the daemon actually served.

The daemon clamps `length` so that the encoded response stays within the page bound
(section 6). It never trusts the length the client asked for. A page may split a
UTF-8 code point.

**Client assembly**

The client builds a blob in this order:

1. gunzip each page;
2. concatenate the bytes by offset;
3. verify the whole blob against its key;
4. decode it using the manifest's `format`.

**Handle table**

The daemon serves a key only if it issued that key in a manifest for the same
session.

- Entries are keyed by `(ownerSessionId, key)`, never by the key alone, so a key
  issued to one session cannot be read through another.
- Each entry records its source: the member repository, the workspace root and the
  path.
- Initial bounds:
  - 8,192 entries per session;
  - 65,536 entries in total;
  - least-recently-used eviction;
  - a 10-minute idle expiry.
- An unknown or evicted key returns `stale`.
  - `stale` is added to `CodeCollabV2ErrorCodeSchema`.
  - Only the new methods return it, and only clients that negotiated
    `codeCollabDiffBlobs` call them.

**Reading each source**

- **Git**
  - `git cat-file blob <oid>`, run in the recorded member repository, returns the
    raw object bytes.
  - The daemon neither decodes them nor validates them as UTF-8.
  - The decompressed object may stay in a short-lived buffer, so that reading N
    pages does not re-read the whole object N times.
- **Turn store**
  - A new read-by-hash API reassembles the snapshot from its verified CDC chunks,
    looked up by `content_hash` (the SHA-256 of the snapshot's UTF-8 bytes).
  - Pages are cut from the reassembled bytes, so page offsets never need to align
    with chunk boundaries.
  - The reassembled bytes use the same short-lived buffer.
- **Disk**
  - Pages are read from the live file by range and are not buffered.
  - Before every page, the daemon re-canonicalizes the recorded path. Unless the path
    still resolves inside that member's workspace root (the existing workspace-root
    constraint), it refuses the read with `invalid_path`. This prevents the path from
    being swapped for an escaping symlink between pages.
  - The daemon hashes disk text once, when it builds the manifest entry. If the file
    changes during a transfer, the client's verification fails. The client then
    discards the blob and re-requests that manifest entry.

**Buffer bounds**

These are initial numbers to be measured: 64 MiB in total, at most
`maxRawTextBytes` per object, and a 60-second idle expiry.

### 3. Authorization

Both methods are pure reads:

- `code-collab/read-blob` joins `file/download-chunk` in `E2EE_READ_QUERY_METHODS`.
  It is authorized through `authorizeRead` and never enters the execution journal.
- `code-collab/open-diff-manifest` is also a pure read. It writes nothing to disk and
  does not call `ensureWorkspaceWatch`.

Starting the watch stays on the existing publication path (activation and turn
refresh). Neither method's permission depends on it.

As a result, read-only members of encrypted workspaces can view diffs, just as they
can already view file text. This is a deliberate change from today, where
`open-*-diff` requires the write role. Those methods keep that requirement for older
peers.

### 4. Per-file generations in the file index

**Readers**

A new field cannot be added to existing rows. Strict normalization
(`normalizeCodeCollabFileIndexValue`) makes older clients drop any row with an
unknown field. Instead, each path gets a sibling row, `[path, 'v']` → `{ g: <token> }`.
Older readers never see it, because `scanCodeCollabFileIndexFlock` skips keys with
more than one segment.

**Writers**

- `CodeCollabFileIndexWritableFlock.set` accepts both `[path]` and `[path, 'v']`
  keys.
- `writeCodeCollabFileIndexToFlock` scans and compares generation rows separately
  from file rows, because the file-row scan cannot see them.
- `publishCodeCollabFileIndexFlock` commits whenever any generation row differs,
  even when every file row is equal.
  - This is still content deduplication, because the generation row's value
    changed.
  - An unchanged row is never re-sent just to refresh a timestamp.
  - The `fis:` signal advances on such commits, as it does today.
- Deleting a path row also deletes its `[path, 'v']` row, in the same commit.
- The implementing PR updates the "one row per path" wording in
  `apps/cli/src/lib/code-collab/AGENTS.md` to "one file row plus an optional
  generation row per path".

**The token**

`g` is an opaque string of the form `<epoch>.<counter>`.

- The epoch is random for each daemon start and is used only for new bumps.
- On startup the publisher keeps the existing `[path, 'v']` values it reads from the
  Flock, so a restart does not republish every row.
- Every bump carries the current epoch, so the same token is never issued for
  different content.

**When `g` changes**

`g` changes when either of the following happens:

- the publication path rewrites that path's file row;
- the publisher sees the scope's base move (a commit, a rebase or a new merge-base)
  while the file row stays equal. Every changed path in that scope is then bumped in
  the same commit.

**How a base move is observed**

1. On each publication, the publisher resolves `HEAD` and the base ref cheaply with
   `git rev-parse`.
2. It compares them with the values recorded at the previous publication.
3. Only if one of them changed does it recompute the merge-base.

This check is separate from the injected `observeWorkspaceGit`, which stays limited
to activation and explicit root refresh. An `open-diff-manifest` call never bumps
`g`.

**What `g` promises**

`g` promises only "may have changed". A false positive costs one small manifest
request, and the blob cache absorbs it because unchanged keys still hit. The scan
does no extra content hashing.

**Client behavior**

The All Changes hook compares generations path by path. It re-requests manifest
entries only for paths whose generation changed and that are open or near the
viewport. An older daemon writes no `[path, 'v']` rows, and today's whole-batch
behavior continues.

**Why `g` is not a content hash**

A content hash in the index would be a confirmation oracle: anyone who can read the
index could confirm a guess of a file's content.

- In ordinary workspaces, that reader is the relay, which can read the Flock stream.
- In encrypted workspaces, it is any member who holds the document key, including
  members who cannot read that path's content through owner-scoped RPC.

Content keys travel only inside owner-scoped RPC responses.

### 5. Hunk mode for large files over remote

**How the daemon knows the plane**

The daemon learns the plane from the entry point, never from the client. The local
`/machine-rpc` handler and the Streams RPC server each pass
`plane: 'local' | 'remote'` into the handler context, so a client cannot claim the
local plane over Streams.

**Remote plane**

An entry carries `hunks` when the plane is `remote` and
`base.rawBytes + head.rawBytes` exceeds the remote hunk threshold.

- `hunks` is a unified patch with a fixed context (3 lines by default) and its own
  byte bound.
- The client parses it with pierre's `parsePatchFiles` into partial metadata
  (`isPartial: true`).
- The client wires pierre's `loadDiffFiles` to fetch both blobs through `read-blob`.
  Pierre hydrates whole files on the first expand, not ranges. That is acceptable:
  both sides are within `maxRawTextBytes`, and the blobs then stay in the cache.
- A patch over its own bound makes the entry `too_large`, with stats only.

**Local plane**

The new methods never use hunk mode locally. They are held only to `maxRawTextBytes`,
not to the per-reply budgets. Desktop uses the new methods too, so a single client
path serves both planes. The existing `open-*-diff` methods keep their current caps
on both planes.

### 6. Budgets and page bound

**Remote budgets**

Remote budgets are measured on the serialized response after the owner-session
envelope has been applied, not on the inner payload.

**Page bound**

The encoded read-blob page bound and the manifest page bound both start at 512 KiB.
This follows the `file/download-chunk` precedent of 512 KiB response chunks.

The real constraint is the Streams append ceiling for the owner-session envelope.
This repository does not define it (`apps/cli/src/lib/file-preview/README.md` says
the same), so it must be confirmed.

**E2EE chunks**

In encrypted workspaces, the E2EE feature layer still slices each response into
256 KiB chunks (`E2EE_FEATURE_CHUNK_BYTES`), up to 16 MiB per result
(`E2EE_FEATURE_MAX_RESULT_BYTES`). The client reassembles them from the original it
keeps locally. This fragments a single response; it is not another round trip to the
daemon. The application page bound is therefore not aligned to it.

### 7. Client blob cache

**Storage interface**

The cache sits behind a small storage interface. The same module then serves
desktop, web and the mobile surfaces in `packages/components`.

**Keys and verification**

Blobs are keyed by `(workspaceId, key)`. A blob is stored only after it has been
verified against its key. A file whose base key is already cached costs only its
head side, and an unchanged file costs nothing.

**Where blobs live**

| Plane and workspace | Storage | Lifetime |
| --- | --- | --- |
| Local plane | Memory only; the daemon is on the same machine, so persisting buys little | In memory |
| Remote plane, ordinary workspace | IndexedDB, as a byte-bounded LRU | Registered in `clear-local-cache.ts`, like the existing IndexedDB caches |
| Remote plane, encrypted workspace | Memory only, byte-bounded | Dropped when the workspace closes and on revocation |

Encrypted workspaces keep blobs in memory because the repository records no rule
that allows file plaintext at rest in the renderer.

**Parsed-diff cache**

The parsed-diff cache key changes from path plus lengths to `(baseKey, headKey)`,
which stays stable across re-fetches.

### 8. Compatibility

**Capability**

A new machine protocol capability, `codeCollabDiffBlobs` (version 1), gates both
methods.

- A missing capability means unsupported. It is never inferred from the CLI version
  (`packages/shared/AGENTS.md`).
- Step 1 freezes the complete v1 schema, so later steps only add producers and never
  change what a v1 reader accepts. The frozen schema covers:
  - the optional `version` and `hunks` fields;
  - `nextCursor`;
  - the read-blob page shape;
  - the `stale` error code.
- The additions to `E2EE_READ_QUERY_METHODS` ship in the same step.

**Fallback**

A client or daemon without the capability keeps using the current methods, which
stay supported.

**Stored data**

Generation rows are additive, and nothing already stored is migrated.

## Alternatives considered

- **Keep full texts and add only a client cache.**
  - Rejected: without keys, the client cannot tell whether it already holds a text,
    so the cache never hits across opens.
- **Daemon-side highlighting tokens (Paseo).**
  - Rejected: it roughly doubles the payload.
  - It binds the daemon to client themes and grammars.
  - It does not reduce the re-sending of the base side.
- **Synchronized text CRDT (Zed's buffer replication).**
  - Forbidden by `apps/cli/src/lib/code-collab/AGENTS.md`.
- **A content hash in the file index.**
  - The simplest invalidation signal.
  - Rejected because of the confirmation oracle described in section 4.
- **Keep diff reads write-role and journaled.**
  - Rejected: every read-blob page would cost an execution claim.
  - It would also keep read-only members of encrypted workspaces away from diffs,
    while they can already read the file bodies.
- **Persist diff bodies off the machine for offline viewing.**
  - Out of scope by the owner's decision (2026-10-31).
  - It changes data ownership and needs its own Spec.

## Delivery

The suggested order is below. Each step can ship on its own, behind the capability.

1. Protocol and daemon:
   - the shared schemas (complete v1), the capability, the `stale` code and the
     read-query entries;
   - plane injection;
   - `open-diff-manifest` with paging;
   - `read-blob` with its three sources;
   - turn-store read-by-hash;
   - the handle table and the buffer.

   Daemon-side tests cover:
   - session-scoped keys and `stale`;
   - raw git bytes and SHA-256-format oids;
   - turn-store pages that cross chunk boundaries;
   - a symlink escape between two pages;
   - length clamping.
2. The client blob cache, and switching the provider for single-file and turn diffs.
3. Generation rows in the publication path, and per-file All Changes loading by
   viewport.
4. Remote hunk mode, with budgets measured after the envelope.

New daemon code follows the Effect v4 selection guide. Whether to migrate the
existing service methods is decided in each PR, not assumed.

## Open questions

- What is the Streams append ceiling for the owner-session envelope? It decides the
  real page bound, which starts at 512 KiB.
- The remote hunk threshold and the patch bound need measuring. A starting point is
  256 KiB of combined raw bytes and a 256 KiB patch.
- The handle-table and buffer bounds in section 2 are initial numbers and need
  measuring.
- May an encrypted workspace persist diff plaintext in the renderer (IndexedDB)? If
  so, under which key, and what happens on revocation?
- Non-git workspaces have no `git:` base, so their base side uses turn-store
  `sha256:` keys. This assumes that the read-by-hash API also covers the earliest-old
  snapshot path that `openCurrentDiff` uses.

## Evidence

Inspected implementation:

- `packages/shared/src/code-collab.ts`
- `packages/shared/src/e2ee-rpc.ts`
- `packages/loro-streams-rpc/src/e2ee-feature-parts.ts`
- `apps/cli/src/lib/code-collab/code-collab-v2-service.ts`
  (`resolveCurrentDiffBaseSnapshot`, `readGitBaseDiffSnapshot`,
  `encodedDiffSnapshotWireBytes`)
- `apps/cli/src/lib/code-collab/code-collab-flock-publish.ts`
- `packages/turn-diff-store/src/sqlite-store.ts`
- `packages/components/src/lib/code-collab-file-index-cache.ts`
- `packages/components/src/components/sessions/use-session-all-changes-diff-data.ts`
- `packages/components/src/providers/workspace-machine-rpc-facade.ts`
- `packages/components/src/ui/diff-viewer/diff-viewer.tsx`
- the public types of `@pierre/diffs` 1.6.1

Related decisions:

- [All Changes diff scope](../../implemented/feature/2026-10-19-all-changes-diff-scope.md)
- [Multi-file diff opening](../../implemented/bug-fix/2026-10-17-multi-file-diff-opening.md)

Prior-art sources were read, not executed. They are the public repositories
zed-industries/zed, getpaseo/paseo, stablyai/orca and slopus/happy, and GitHub's
repository-limits documentation.

Executed validation: none.
