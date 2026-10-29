# @lody/memory

Platform-neutral personal Role memory over one LoroDoc. The document core and local
CLI/Renderer integration are implemented; production cross-device sync and personal
E2EE authorization remain unavailable. The [memory Spec](../../specs/agent-role-memory.md)
remains draft.

## Ownership and integration

Lody Memory is a provider beside external ones such as Nowledge. A person creates any
number of named memories (at most 64) in Settings → Memory; a Role links one through
the binding `{providerId: "lody", memoryId}`. The logical identity is `(workspace,
authenticated user, memoryId)`: machines, models and Roles do not identify a memory,
and several Roles may share one. Nowledge's machine-scoped identities and environment
mapping remain unchanged; Lody Memory needs no machine inventory or imported association.

Each memory's name and description are the leading front matter of its own `MEMORY.md`
(`---\nname: …\ndescription: …\n---`), so Agents read them with the entry and there
is no second copy. A per-owner catalog Doc lists the memory IDs; creation writes the
profile before listing the memory, and deletion unlists it and then removes all of its
documents. Only a listed memory can be opened for an Agent.

The daemon resolves the active frozen turn, current local Role catalog and the owner's
memory catalog on access. Unlinking or deleting the Role, or switching it to another
memory, revokes subsequent tool access to the old one but retains its content.
Ordinary sessions without a Role do not get memory. The current host admits only its
own authenticated user, including on a shared machine; collaborators cannot borrow
the machine owner's memory. Previously disclosed conversation/model context is not erased.

`@lody/memory/repo` is an optional adapter over the existing Promise LoroRepo. CLI
storage is a separate SQLite database under the installation data directory,
`personal-memory/<workspace>/<user>/memory.sqlite3`. Renderer replicas have separate
IndexedDB databases per window, workspace and user. Both retain the existing local
Loro data-plane protocol, with a dedicated personal repository and doc rooms. Neither
workspace metadata nor a Streams transport receives personal content. There is no
Markdown projection or second writable truth source.

Agent tools use the existing daemon `session/call-tool` route. Every prompt with a
built-in binding receives a bounded MEMORY.md entry as reference data and tool usage
guidance. Tools search/read/list/sources/create/update/forget take only content/path
inputs, not principal/Role IDs. Agent sources record the causal session and turn.
A write receipt follows `repo.flush()`; commit alone is not saved. Disk failure returns
no success and retains the edit for retry. Remote synchronization does not gate a local save.

Settings → Memory shows Lody Memory above the machine tabs because it belongs to the
person, and groups Nowledge and other machine-bound providers under "Integrated
providers". The Role editor lists Lody memories before provider associations and binds
them only on the local machine tab whose daemon advertises `builtinMemory: 1`: the
Renderer replica replicates only to this device's daemon. Renderer edits are authored
in its own Loro replica, not delegated to CLI RPC. Ordinary cache clearing preserves
them; explicit full local reset remains destructive.

No cloud memory sync is attached, even in a cloud workspace. Future integration must
reuse the existing E2EE core/device authorization with a personal resource scope,
covering bodies, sensitive directory/provenance, indexes and snapshots. Necessary
plaintext remains visible to authorized execution endpoints and model services.

## Loro layout (format 1)

Rooms are `personal-memory/<owner>` for the catalog and `personal-memory/<owner>/<memoryId>`
for each memory. The catalog Doc is `memories: LoroMap<memoryId, createdAt>`.

```text
meta: LoroMap
  formatVersion: 1
  identity: LoroMap
    memoryId, ownerId: string
    ownership: "personal"
documents: LoroMap
  "MEMORY.md": mergeable LoroMap
    createdAt: number
    description?: string
    body: mergeable LoroText
    changes: mergeable LoroMap<changeId, plain ChangeRecord>
  "projects/example.md": mergeable LoroMap
    ...same fields...
```

Relative Markdown paths are literal Map keys, including slashes. There is no separate
document ID, duplicate path field, path index or name-uniqueness scan.
Use `documents.ensureMergeableMap(path)`, then `ensureMergeableText('body')` and
`ensureMergeableMap('changes')`. Concurrent same-path creation addresses the same
containers and merges their text operations and source records. Scalar metadata
uses Loro Map conflict resolution. CRDT convergence does not judge contradictory
knowledge or deduplicate identical prose.

The path is the document identity. Paths are NFC, case-sensitive, relative Markdown
names; `[[projects/example]]` resolves to `projects/example.md` by direct lookup.
They are not filesystem access or execution grants. Links are reference data.
The [Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/SPEC.md)
informs the short entry, topic organization, wiki links and provenance; its Git
workflow and Skill installation are not used.

`initializeMemoryDoc` accepts only an empty Doc, initializes metadata and the empty
`MEMORY.md` entry, and commits. This package is unreleased; the path-keyed layout remains
format 1, with no migration layer for development iterations.

## Operations

| Method       | Behavior                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `startup`    | Separate fixed usage instructions and bounded entry reference data.                                                             |
| `list`       | Sort path keys and page metadata, without reading bodies.                                                                       |
| `resolve`    | Direct lookup of a relative Markdown path or wiki link.                                                                         |
| `read`       | Read current body by Unicode code point offset/limit.                                                                           |
| `search`     | Match path keys in JS and descriptions/bodies with fixed JSONPath; rank path, description, then body matches.                   |
| `provenance` | Page source records by change ID.                                                                                               |
| `create`     | Ensure the path and write supplied body/description. An existing path is edited, not duplicated. Omitted description clears it. |
| `update`     | Edit an existing path. Omitted description preserves it; null/empty clears it. Optional `newPath` moves the document.           |
| `forget`     | Record provenance, then remove the path key. Missing paths return `not_found`.                                                  |

All operations use live state; there are no hashes, revision gates or snapshot-bound
cursors. Pagination uses numeric `offset/limit` and `nextOffset`; edits between calls
may shift positions. Reads beyond a shortened body return an empty page.
Text updates use LoroText's native diff. Expected input failures return content-free
codes; broken internal structure throws a content-free error.

Source records carry actor, session/turn when Agent-authored, timestamp and operation
kind. They track document edits rather than exact per-sentence attribution.
New source IDs come from the host; the core does not rescan history for duplicates.

### Rename and deletion

`update({ path, newPath })` copies visible content, metadata and source records into
the destination's mergeable containers, records the move and deletes the source key.
The source and destination have different path-derived identities. Already-visible
destinations return `path_exists` rather than being overwritten. This is a direct key
check, not a uniqueness scan. Concurrent arrivals at the same new path merge normally.

Moves are content migration, not a CRDT identity-preserving move: an offline edit
to the old path remains in its hidden history, and concurrent moves to different
destinations can produce two documents. Links elsewhere are not rewritten.

Deleting a mergeable key hides its state. Reads and updates never ensure missing
paths, so an offline child edit does not reactivate a deleted path. Explicit
`create` (or a move to that path) may reactivate it: the supplied body/description
become current content while retained source/history remain. This follows
[Loro mergeable semantics](https://www.loro.dev/docs/concepts/container).
`MEMORY.md` is reserved: edit or clear it rather than create/move/delete it.

## Bounds and search

Limits: entry 8 KiB; body 64 KiB; total visible bodies 8 MiB; 256 documents;
description 300 code points; query/path 256 code points; result page 50 items;
read page 4,000 code points; search excerpt 240 code points.

Inputs and state-dependent limits are checked before expected mutation failures.
Imports can exceed quotas; metadata edits, reductions and deletions remain possible.
A move does not consume an extra document slot. These limits do not bound CRDT
history or provenance retention; no automatic compaction is implemented.

Description is optional and improves ranking but never filters out body-only matches.
JSONPath uses escaped literal `contains` filters for description/body. Paths are
matched directly against keys; the builder does not itself search paths. Search
may scan current bodies; output pagination does not bound scan cost. No vector index,
remote service or arbitrary model-supplied JSONPath is used.

## Example

```ts
import { initializeMemoryDoc, openMemoryDocument } from '@lody/memory/loro';

// hostDoc, identity and context come from the authorized host.
const initialized = initializeMemoryDoc(hostDoc, identity, context);
if (!initialized.ok) throw new Error(initialized.error.code);
const opened = openMemoryDocument(hostDoc, identity);
if (!opened.ok) throw new Error(opened.error.code);
const memory = opened.value;
memory.create(
  { path: 'preferences.md', description: 'Writing preferences', body: 'Prefer concise replies.' },
  nextTrustedContext
);
memory.read({ path: 'preferences.md' });
```

## Verification

`pnpm --dir packages/memory test`, `typecheck`, and `format:check` exercise the package.
Behavior tests use real Loro 1.17.0 replicas: same-path creation, shared text/source
merging, independent additions, moves, deletion/reconnection, explicit recreation,
snapshot recovery, scope isolation, search escaping, quotas and bounded live reads.
The CLI's `tests/personal-memory.test.ts` additionally exercises real SQLite restart,
authorization, MCP input validation and source attribution, storage failure/retry,
and the existing local data-plane adapter. These do not certify production E2EE or
a packaged desktop/Agent end-to-end run.
