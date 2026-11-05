# Content-addressed remote diff transport

Status: implemented
Translation: current
PR: [#2316](https://github.com/LodyAI/Lody/pull/2316)

[中文](2026-10-31-remote-diff-transport.zh.md)

## Abstract

Remote diff reads previously retransmitted both complete file texts on every open,
and All Changes updates invalidated a whole body batch. The transport now separates
paged manifests from verified, content-addressed byte reads, with per-file opaque
generations and deferred bodies. Ordinary remote workspaces can persist verified
blobs; encrypted and local workspaces keep them in bounded memory. Large remote
files start with partial patches and hydrate complete files on context expansion.
This reduces repeat body traffic; it does not provide offline viewing or establish
production latency improvements.

## Decision

The additive `codeCollabDiffBlobs` v1 capability gates `open-diff-manifest` and
`read-blob`. Missing support retains the old APIs and their budgets. Both new
methods do not start watches or mutate evidence. Encrypted calls retain existing
write authority and execution claims; Guest diff access is deferred to a separate PR
by the owner decision on #2316. The plaintext-cache and compatibility decisions are recorded
for human review in the [draft Spec](../../../../specs/remote-diff-delivery.md).

The manifest enumerates the existing turn/All Changes/single-path set, focus first,
then smaller changes. It carries nullable base/head descriptors, stats, status,
opaque version and optional hunks. Transport priority does not change the panel's
alphabetical ordering. A complete successful Branch manifest also replaces the
provider's live Changes list, so the sidebar and panel use the same path set.
A focused path absent from that set gets an explicit no-changes message. Empty
batches say “No changes.” Partial, failed or superseded requests do not replace
sidebar metadata; Uncommitted/turn reads do not overwrite Branch metadata. Pages hold at most 64 paths and 512 KiB of encoded
remote response. Opaque cursors pin the scope, resolved Git/member bases and initial
path set for ten minutes; additional file roots have their own bases and the focus never narrows the set; moved bases or evicted cursors fail with `stale`.

Blob pages address raw offsets, may split UTF-8 characters, and carry gzip-base64.
The client reconstructs and verifies the complete bytes before UTF-8 decoding,
preserving BOM and newline bytes. Each side is capped at the existing 10 MiB raw
text limit, including a lower injected service limit. The daemon clamps each page
before allocation and shrinks it until the host-supplied envelope measurement fits
512 KiB. The transport entry point supplies local/remote context; JSON cannot select
local policy. The ordinary compatibility envelope is measured after owner encryption;
this also conservatively bounds the encrypted feature result, whose codec enforces
its own complete-result and sealed-frame limits.

### Sources and authority

A handle is issued only by an authorized manifest and keyed by requested session
and content key, with resolved owner, workspace and source. Every page reauthorizes
the session and checks that binding. Unsupported symlinks, directories and Gitlinks
(including commits absent from the superproject) become per-file binary entries.
Operational file failures become typed per-file unavailable entries; request/path
authorization failures still reject the request. Removal/rename during a disk read
returns `stale`, allowing bounded metadata refresh. Descriptor capture retries a
single `stale` failure once against the same pinned base before isolating it as a
per-file error. Client error mapping retains permission refusals rather than
presenting them as temporary I/O failures. Limits are 8,192 handles per requested session,
65,536 globally, LRU eviction and ten-minute idle expiry. A guessed global hash does
not establish authority. Git/store reconstruction buffers are capped at 64 MiB total
and 8,192 objects, and expire after 60 seconds idle; the passive registry owns no timers.

- Git keys are `git:<oid>`, including SHA-1 and SHA-256 repositories. Resolution and
  `cat-file blob` run in the owning member repository. The client hashes the Git
  `blob <length>\0` header plus raw bytes with the algorithm selected by oid length.
- Disk keys are raw-byte SHA-256. Pages recheck the canonical path, workspace
  containment and opened file identity; escaping symlinks fail. A same-size edit
  during transfer fails whole-blob verification and causes one manifest retry.
- Turn keys use the existing full UTF-8 `content_hash`. New worker descriptor reads
  select owner/path/old-or-new under retention without decompression; byte reads
  repeat that selection, check the requested hash and raw size, then reuse verified
  chunk reconstruction. No schema migration is needed. Historical turns use stored
  evidence exclusively. Earliest-old means earliest retained and unexpired, as before;
  if it moves before an issued blob is buffered, that handle fails instead of
  silently substituting another snapshot. Null and zero-byte files remain distinct.

Both transport planes use a separate read-only store adapter and existing-path resolver. It does not create a missing
DB, initialize/migrate an existing schema, start GC or admit mutations. This avoids
turning a diff read into a write through lazy worker initialization, workdir creation or member-link repair.

### Invalidation without content disclosure

Older readers reject unknown fields in strict file rows, so generations use additive
`[path, 'v'] -> { g: <random epoch>.<counter> }` siblings. Legacy scans skip these keys.
Writes compare siblings separately, commit generation-only changes, delete orphan
siblings with their file row and advance the existing signal after publication.
Generation siblings count toward the [whole-index and publication budgets](../bug-fix/2026-11-05-code-collab-file-index-budget.md).
Each changed path reserves a second row and up to 64 encoded token bytes. File rows,
generation-only changes and orphan sibling cleanup use the same byte-bounded commit
plan, with flush/sync after each batch. Older oversized tokens are renewed before
publication rather than exceeding the reservation. This reduces file-index capacity:
a changed path consumes two physical rows and its generation byte reservation.
At the 1,000-row ceiling, at most 500 all-changed paths fit before byte/directory
costs; a synthetic 500-file root that fit before retained 268 paths under 100 KiB.
Pruned directories remain lazy-expandable; All Changes enumerates its full set via
the manifest independently of this bounded tree/mention metadata.
No content hash enters the shared index: a hash would let any index reader confirm
whether a guessed private file body exists, even without owner-scoped read access.

Private per-path disk identity/size/mtime/ctime and retained non-Git base descriptors
invalidate a changed path even when its line counts stay equal. HEAD/base ref changes
invalidate changed paths. On first publication after restart, changed-path generations
are refreshed once while unchanged file rows remain deduplicated. This deliberately
revises the proposal's startup-token preservation: without a durable base fingerprint,
preserving all tokens could miss an offline base move or same-stats edit. It avoids
adding another durable metadata contract just to eliminate that one metadata refresh.

The shared file-index resource emits generation-only updates to refresh live views.
An index token does not prove freshness after a host watch expires. Each All Changes
load therefore revalidates the paged manifest, and a batch descriptor is consumed
once by its visible file; subsequent opens revalidate metadata while reusing verified
bodies. At most 128 pending descriptors are retained. The machine's returned file
set and its viewport are authoritative even when the index is stale. This trades extra metadata for
correctness without retransmitting unchanged bodies.

The provider owns the live Branch list and its listeners for that provider's
lifetime. Successful complete comparisons notify the summary hook; a request-start
sequence rejects older completions, and cancellation/cache disposal prevents late
publication. The list is local presentation metadata, never a renderer write to the
shared index. Provider replacement returns to the new index until its next live
comparison completes. Live Changes remains available without the optional history
reader; historical turn summaries still follow retained history. Keeping a separate
stale sidebar after accepting a complete manifest was rejected because it presents
two incompatible answers to the same comparison.

Writer diff activity separately renews the existing `init-directory` publication
workflow, at most once per five minutes (five seconds after failure), to preserve
its ten-minute watch lifetime. Guest file reads skip this action; diff access remains writer-only in encrypted workspaces. Activation is observed
background work and cannot gate content on a failed publisher; the two blob RPCs
remain pure reads. In-flight activation is shared within the provider runtime;
owner/root changes retire that runtime. Body RPC permits remain held through raw
request settlement after cancellation. Only negotiated blob paging is cancellable:
legacy in-flight results remain usable across scroll pauses, even when capability
negotiation initially supplied a controller. Optional cache classification does not
wait for unresolved machine routing; unknown routes use memory only.

### Caches and large remote files

Verified blobs use workspace-scoped keys and 64 MiB / 2,048-entry memory LRU bounds.
Ordinary remote workspaces opt into a globally bounded IndexedDB LRU with the same
limits, explicitly registered with cache clearing. Protected/local workspaces never
open that DB for blobs. Workspace disposal or lost content admission clears the new
memory caches; an epoch prevents a late read from repopulating a cleared cache. Disk/cache failures degrade to authorized reads, not durable failures;
corrupt cached bytes are discarded and reread. Partial or unverified blobs are never
cached. The parsed viewer key includes both content keys and the path.

Above 256 KiB combined raw size, remote manifests carry a unified patch with three
context lines and at most 256 KiB. Patch work is also bounded at 600 line edits;
a larger rewrite falls back to verified full blobs, as does an encoded patch that
exceeds its page budget. Only the raw content cap makes text unavailable. Local
manifests keep full descriptors without remote hunk policy. Pierre parses patches as partial metadata, then its first context
expansion fetches complete verified files. A separate expansion read controller
cancels subsequent pages when the block hides/unmounts; initial manifest/body reads
also stop further page starts when their surface hides. No extra renderer or worker
architecture was added.

Hunks and hashes come from the same captured bytes. Deferred expansion renews expired
handles once. Only unchanged content identities may hydrate the original patch.
If either file side or status changed, the panel reloads the whole comparison batch
(including base header, file set and stats), or the active turn comparison. It never
replaces old hunk coordinates in place under an old base header. Other expansion
failures show a visible error and a Retry action. During a reload, the previous
coherent batch remains visible with a refreshing indicator until the new manifest
completes. Unchanged content keys retain their viewer metadata, hydrated context
and card state; changed files receive fresh loaders. The viewport keeps its anchor
observer across path-list changes. Retry remounts only the failing viewer instead
of every file. These state-preservation changes do not permit mixing content from
different comparison identities. Reverted files retain readable descriptors even when marked
`not_changed`. Runtime-bound partial loaders never enter the cross-workspace immutable
turn cache; fully materialized turn snapshots can still be retained.

## Verified transport constraints

Source inspection on 2026-11-04 distinguishes transport ceilings from application
budgets:

| Layer | Enforced bound | Implication |
| --- | --- | --- |
| Ordinary Streams append | Public gateway default and storage HTTP body limit: 64 MiB | One ordinary response is one append, with no automatic Lody fragmentation |
| Encrypted feature result | 16 MiB complete serialized result | Larger results fail explicitly before page sealing |
| Encrypted frame | 1 MiB sealed, including 143 bytes overhead | Feature payloads already split into 256 KiB chunks |

The exact locked `@loro-dev/streams-client` 0.12.1 appends through one HTTP POST.
Gateway code rejects both declared and streamed excess with HTTP 413. These are
public source defaults, not measurements of a deployed gateway. The existing
`file/download-chunk` 512 KiB raw range has a larger encoded response and does not
establish a 512 KiB wire limit. The chosen diff page size bounds scheduling, memory
and cancellation work; hashes and cache reuse are what eliminate duplicate bytes.

Public source revision `9dd723175fccc5fc669676fd8d05b37efb82945e`:
[gateway](https://github.com/loro-dev/loro-streams/blob/9dd723175fccc5fc669676fd8d05b37efb82945e/riverrun-gateway/src/proxy/upstream.rs#L124),
[storage](https://github.com/loro-dev/loro-streams/blob/9dd723175fccc5fc669676fd8d05b37efb82945e/rr/src/server.rs#L485).
A direct production-codec probe accepted exactly 16 MiB, reconstructed 64 feature
pages, and rejected one additional byte. No live gateway limit probe was performed.

## Alternatives and consequences

- Keeping full texts with a client-only cache cannot identify reusable content before
  transfer. The immutable base is still retransmitted.
- Daemon highlighting tokens add payload and bind the host to themes/grammars;
  Paseo's full hunk snapshots also retransmit every update. Zed's base caching and
  Orca's encoded remote budgets informed this split; synchronized text CRDTs remain
  outside Code Collab's contract.
- Content hashes in Flock are simpler invalidation but expose a confirmation oracle.
  Random generations preserve compatibility and avoid that disclosure.
- Moving diff reads into Guest authority would change access to Git bases and retained
  evidence. #2316 preserves the existing writer restriction; that feature is deferred
  to an independently reviewed PR.
- Encrypted IndexedDB plaintext has no established repository allowance. Memory-only
  caching is the implemented policy, not an unanswered prerequisite.
- Server-persisted diff bodies would enable offline use but change ownership and are
  outside this work. The current client still needs a live admitted machine/manifest.

The existing legacy service remains the I/O owner. The Effect feature/fix assessment
kept new registry/hash work pure or passive and extended the existing worker and RPC
owners. A read-worker shutdown error is reported after the writer, tunnels and documents have each had their independent cleanup attempted; no retry loop or retained failure is added. No independent lifecycle unit or migration dependency chain was introduced.

## Verification and limits

Behavioral evidence lives in:

- `apps/cli/src/lib/code-collab/code-collab-v2-service.test.ts`: real SHA-1/SHA-256
  Git and disk bytes, BOM/CRLF/Unicode, session binding, path escape, expiry, page
  clamping, moved-base cursors, historical/non-Git worker reads, local/remote hunk
  policy and unchanged-stats invalidation, deleted files, capture-time edits and
  hunk-budget fallback.
- `packages/turn-diff-store/tests/sqlite-store.test.ts`: read-only descriptor/byte
  selection, owner separation, retention, full reconstruction and worker messages. A separate smoke of the emitted CLI `turn-diff-store-worker.js` opens an existing database read-only and verifies descriptor-addressed BOM/CRLF/Unicode bytes.
  The earlier unchanged-store probe restored 400,020 UTF-8 bytes across four chunks
  and checked the full hash, null/empty distinction and GC; it motivated reusing this
  store rather than introducing another snapshot representation.
- `packages/shared/tests/code-collab.test.ts` and CLI Flock publication tests:
  legacy rows survive generation-only changes and deletion removes siblings.
- `packages/loro-streams-rpc/tests/machine-rpc-server.test.ts` and
  `tests/e2ee-native.test.ts`: measured owner envelopes, wrong-owner refusal and real
  signed writer authority with Guest manifest/blob and save refusals.
- `packages/components/tests/code-collab-session-file-provider-v2.test.ts`:
  initial metadata sends zero body bytes; the first open sends base plus head;
  repeat opens revalidate metadata but send zero additional body bytes; an edit with
  unchanged index generations fetches only its new head. It also checks corruption,
  cancellation,
  protected memory policy, IndexedDB retention/eviction and unavailable storage.
  Deferred hydration covers expired unchanged handles and comparison invalidation on live edits, reverts or changed bases, while runtime
  replacement exercises the real immutable-turn hook cache.
- `packages/components/tests/e2e/diff-viewer-large-diff-performance.spec.ts`:
  the real panel/Pierre path renders partial hunks with zero blob traffic and
  hydrates full context on expansion; stale-index files remain visible and loadable
  through the same viewport boundary. Expansion failures expose retry, and a renewed
  comparison refreshes the entire batch and base header.

These are deterministic synthetic/local behavioral checks, not production bandwidth,
latency, mobile device-memory or hosted deployment benchmarks. Existing diff methods
remain available for peers without the capability. Related decisions:
[All Changes scope](../feature/2026-10-19-all-changes-diff-scope.md),
[multi-file opening](../bug-fix/2026-10-17-multi-file-diff-opening.md).
