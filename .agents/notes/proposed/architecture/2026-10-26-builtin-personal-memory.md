# Built-in personal memory: independent package architecture

Status: proposed
Translation: current

[中文](2026-10-26-builtin-personal-memory.zh.md)

## Abstract

Lody's existing provider binds external identities without storing personal Role
knowledge. The independent `@lody/memory` package implements a synchronous document
service over one personal LoroDoc; the host retains authorization, persistence and
transport ownership. Documents now use relative Markdown path keys and mergeable
containers, so concurrent same-path creation addresses one shared document.
This trades rename-stable document identity for a simpler path-addressed model.
Local host integration is now wired; production encrypted sync remains unavailable.
This note does not approve the broader storage/ownership Spec.

## Decisions and responsibilities

The [package README](../../../../packages/memory/README.md) owns the implemented
layout, API, limits and pending integrations. The [memory Spec](../../../../specs/agent-role-memory.md)
remains draft. The [Nowledge decision](../../implemented/feature/2026-10-04-agent-role-memory.md)
and external provider data are unchanged.

One trusted person and a memory ID identify one memory across machines; a Role links
a memory through its `lody` binding, so several Roles can share one. Role/model
names, machine IDs and working directories do not partition it. This replaces an
earlier per-Role identity (`lody/role`, one implicit memory per Role) so that people
can name, describe and reuse memories as a provider beside Nowledge. The cost is that
a copied Role now shares its linked memory instead of starting an empty one. Names
and descriptions live in each `MEMORY.md` front matter; a per-owner catalog Doc lists
only IDs, avoiding a second writable copy of the profile.
History diffs reuse Loro history rather than storing body snapshots in source records:
each mutation's commit message carries its change ID, which keeps it an unmerged change
whose dependencies and last op bound the versions to compare. Snapshots per record were
rejected because every keystroke edit would copy up to a 64 KiB body. Only personal
ownership is implemented; workspace partitions remain distinct. Personal device
authorization for cloud synchronization remains future work. Role switching, transcript disclosure and host filesystem
isolation are outside the narrowed package scope.

The host supplies an authorized Doc, admits imports, preserves its binding and
checks current access. Identity is validated at open, not on every operation.
Unique source change IDs come from the host. No daemon proxy writer, parallel
persistence source, network client, Git workflow or new crypto protocol is added.
In-memory commit is not a durable-save receipt. Production sync remains disabled.

## Local host boundary

The package README owns the implemented host behavior. The daemon's active frozen
turn supplies principal and Role; live local Role and memory-catalog reads enforce
subsequent unlink, relink or memory deletion without changing accepted configuration. The current host refuses other
users' personal access, even on a shared machine. Rename/model changes preserve the
binding; copied Roles keep the same linked memory. No transcript erasure is claimed.

Personal SQLite and Renderer IndexedDB repositories never join workspace metadata
or Streams. Renderer writes use existing local Loro replication, not proxy commands.
The memory UI and runtime negotiate `builtinMemory: 1` before connecting, preventing
old daemons from receiving personal rooms through ordinary workspace routing.
Ordinary cache clearing excludes durable personal IndexedDB replicas.

Effect assessment: small scoped layers own lazy host repository creation/close.
The existing local transport and workspace room resolver still use the published
Promise Repo; replacing them with native Repo is an unfinished dependency chain,
not part of this integration. The separate `./repo` adapter retains that boundary;
this is not a claim of native data-plane migration. No new retry/fencing subsystem
or custom encryption protocol is introduced. Production E2EE remains blocked on
personal resource authorization and the existing device/key/data-plane integration.

Verification uses pinned Loro 1.17.0/Repo 0.25.0 and real SQLite, plus actual MCP
registration and local data-plane replication. Isolated package/host tests and
focused types pass (91 behavior cases across core, host, providers, Roles and turn
freezing). Full workspace checks require the checkout's missing tools and ACP
dependencies; the existing cache-clear suite could not be run in the isolated harness. A packaged desktop/real Agent smoke test remains unexecuted.

## Path identity and mergeable containers

The requested path-keyed model replaces the earlier independent document-ID design.
The layout stores each relative Markdown path directly in the root documents Map.
Each entry uses ensureMergeableMap(path), with ensureMergeableText('body') and
ensureMergeableMap('changes'). There is no duplicate path field or ID/path index.
The [Loro API](https://www.loro.dev/docs/concepts/container) derives these container
identities from parent, key and type; real 1.17.0 replica tests confirm concurrent
same-path creation merges both bodies and source maps. Scalar metadata follows
Loro Map resolution, and CRDT merging does not resolve knowledge contradictions.

Creation writes supplied content to the ensured path, including an existing path.
Updating a missing path returns not_found. Deleting a path hides its mergeable
state; offline child edits do not reactivate it. Explicit creation can reactivate
the same container and retained provenance with the newly supplied body/description.

Rename uses newPath: copy visible metadata, body and source records to the destination,
record the move, then delete the source key. It is content migration, not an
identity-preserving CRDT move. A visible destination is rejected by direct key lookup;
concurrent arrivals at the same new path merge. Offline edits to a removed source
stay in hidden history; concurrent moves to distinct destinations can duplicate
the document. Links are not rewritten. These are accepted consequences of path identity.

The package is unreleased. The path-keyed layout stays at format 1; development
iterations do not require a version bump or migration layer.

## Service boundaries and evidence

The service uses live Loro state without content hashes, revision gates, tombstones
or snapshot-bound cursors. Bounded pages use numeric offsets. Metadata listing
does not load bodies; path resolution is direct Map lookup. Search matches keys
directly and uses fixed literal JSONPath for descriptions/bodies. Descriptions
improve ranking without excluding body-only matches. Internal corruption throws
a content-free error; expected input errors are structured results.

The tests exercise real replicas and snapshots: same-path concurrent initialization,
independent additions, edits, rename, deletion/reconnection/recreation, path-key
search and escaping, provenance, quotas and personal scope isolation. Type and
format checks use the locked direct dependencies in an isolated harness because
the checkout lacks root dependencies and initialized ACP submodules.
Document/public-boundary checks have existing missing-submodule failures.
These checks prove neither host durability nor production synchronization/E2EE.

The experiments below predate the path-keyed layout and use the original synthetic ID-keyed
fixtures. They compare Loro operations/layout scale, not the new service's measured
latency or memory cost. Their raw evidence is retained without relabeling it.

## JSONPath search experiment (2026-10-27)

The workspace pins `loro-crdt` 1.17.0. An isolated experiment used that exact npm
package with Node 24.22.1 on Linux x64; no repository dependencies were changed.
Each document was a nested LoroMap with a path and a LoroText body of 32,768
characters of repeated mixed Chinese/English text. Every sixteenth document had
`needle测试` appended. All four methods returned identical matching paths.
After ten warmups, median milliseconds over 80 queries were:

| Documents | JSONPath contains | JS container reads | Full toJSON then scan | Cached JS strings |
| --------- | ----------------- | ------------------ | --------------------- | ----------------- |
| 32        | 0.552             | 4.093              | 4.107                 | 0.925             |
| 256       | 4.866             | 29.759             | 32.887                | 7.964             |

The query was `$.documents[?(@.body contains "needle测试")].path`.
Building the JS string cache separately took approximately 8 and 49 ms.
This is a warm synthetic substring benchmark, not a production latency guarantee,
ranking benchmark, inverted-index comparison or proof of the fastest possible
search. Loading, incremental updates, snippet generation and pagination were not
measured. JSONPath `search()` was separately tested and triggered a WASM panic;
use supported `contains`, not the unimplemented function.

Prefer bounded JSONPath substring search as the initial implementation candidate,
rather than presupposing a separate text index. Lody constructs the query with
validated/escaped literals; the Agent supplies keywords, never arbitrary JSONPath.
Query scoping occurs before opening the Doc. Benchmark more realistic workloads
before adding an index. See the [official JSONPath guide](https://loro.dev/docs/advanced/jsonpath).

## One Doc versus ten Docs (2026-10-27)

A second experiment compares one logical memory containing ten 4,000-character
Chinese documents (120,000 UTF-8 bytes total), either in one LoroDoc or in ten
LoroDocs. Both layouts use nested LoroMaps and LoroText, identical deterministic
synthetic content and JSONPath `contains`; two documents match. Each case runs in
five independent Node processes; reported values are medians. All assertions for
content length and expected search results passed. Environment: Loro 1.17.0,
Node 24.22.1, Linux x64, Intel Xeon CPU at 2.20 GHz.

| Operation, milliseconds                                           | One Doc | Ten Docs |
| ----------------------------------------------------------------- | ------- | -------- |
| Cold-process import of all snapshot bytes                         | 19.57   | 23.83    |
| First full search, after reading one topic                        | 12.13   | 12.54    |
| Warm full search                                                  | 0.126   | 0.410    |
| Replace four characters in one topic and commit                   | 0.042   | 0.040    |
| Replace four characters in each of ten topics and commit each Doc | 0.296   | 0.324    |

Warm search has ten warmups and 100 samples per process. Updates have 100 samples;
text length remains constant. Cold operations include first-use WASM/JIT effects,
not filesystem reads or fsync. Snapshot bytes are read before timing and before
the memory baseline. No Streams, encryption, persistence adapters, UI or network
is included.

To reduce the dominance of one-time runtime costs in memory measurements, a
separate case keeps 100 independent logical memories live and runs a full search
on each. RSS increments after explicit GC are 61.19 MiB for the single-Doc layout
and 97.24 MiB for ten Docs per memory: approximately 0.612 versus 0.972 MiB per
logical memory including amortized runtime costs. WASM linear-memory capacity
increases by 49.81 versus 80.00 MiB for all 100 memories. Capacity is not live
allocated bytes and is not added to RSS. Single-memory first-search RSS increments
are 7.67 versus 8.88 MiB, illustrating why they must not be presented as pure
per-memory storage sizes.

A history fixture adds 100 rounds of edits to all ten topics before snapshotting
(1,000 four-character replacements). Across 100 loaded-and-searched memories,
RSS increments are 63.18 versus 105.56 MiB; warm single-memory search remains
0.125 versus 0.413 ms. This localized edit history does not model years of edits,
large deletions or many peers.

Selective access reverses the memory advantage: when only topic zero is needed,
the single layout imports its one complete snapshot while the split layout imports
only that topic's snapshot. Across 100 logical memories, after reading that topic,
RSS increases by 34.71 versus 14.40 MiB. The other nine split Docs are never opened;
no global search occurs in this case. This is the actual benefit of splitting,
not a benefit when all topics must be searched.

Explicitly freeing Docs does not promptly reduce RSS or WASM capacity in this
experiment. Releasing ownership permits allocator reuse; it does not establish
immediate return of memory to the OS. At this tested scale, prefer one Doc for
simple full-memory search and updates; reconsider partitioning if measured scale
or predominantly selective access warrants its additional search/index machinery.

Reproduce with the [benchmark script](2026-10-26-builtin-personal-memory-bench.cjs),
passing an absolute path to an unpacked `loro-crdt@1.17.0/nodejs` directory:

```sh
node .agents/notes/proposed/architecture/2026-10-26-builtin-personal-memory-bench.cjs /absolute/path/to/loro-crdt/nodejs
```

The script spawns GC-enabled isolated children and removes its synthetic temporary
snapshots. [Raw results](2026-10-26-builtin-personal-memory-bench.json) retain all
five process samples, memory checkpoints and environment details. These are
non-gating measurements, not deterministic timing assertions or product acceptance.
