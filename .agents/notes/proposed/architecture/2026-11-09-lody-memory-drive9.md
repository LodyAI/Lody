# Lody Memory on drive9: private and shared memories as files

Status: proposed
Translation: current

[中文](2026-11-09-lody-memory-drive9.zh.md)

## Abstract

The unreleased Loro-based Lody Memory stores each memory in a CRDT document. People
cannot open, index or search that document with ordinary tools, and personal E2EE
blocks cross-device use. This proposal stores each memory as Markdown files in a
hosted [drive9](https://drive9.ai/) file service. A memory is **private** (reached
only through the daemon's SDK) or **shared** (workspace members have read-write
access, with a proposed mount); visibility can change after creation. The trade-offs are that
memory content becomes plaintext on the hosted service, memory works only online,
and the OSS desktop build has no Lody Memory. P1 establishes basic scoped file
access, but the pinned Drive9 lacks mount credential hot rotation. Lody Agent tool
writes take priority; current-memory provenance is required, recoverable history
is not. Mounts must renew without interruption if shipped; their launch timing
remains open. Fresh reads and local refresh instead of SSE are a recommendation
pending approval; the [P1 gates](#p1-verification-before-implementation) remain open.

## Decision

The owner decided the following:

- **No backward compatibility.** The Loro memory never shipped, so no data is
  migrated and the
  [Loro design](../../rejected/architecture/2026-10-26-builtin-personal-memory.md)
  is rejected.
- **No E2EE for memory.** Plaintext memory on the hosted service is accepted for
  both private and shared memories. Access control replaces cryptographic
  confidentiality.
- **Shared means workspace members.** Every member of the workspace gets
  read-write access. Read-only membership is not offered initially.
- **Lody hosts the drive9 tenants.**
- **Online-only is accepted.**
- **Prioritize Agent tool writes in Lody** over arbitrary editor saves.
- **Provenance is required per current memory entry; recoverable history is not.**
  Unchanged entries retain their sources when another entry is updated.
- **External/unknown provenance is accepted** when external edits cannot be
  reliably attributed. Never carry stale Agent attribution onto changed content.
- **Credential renewal must not interrupt mounts.** Unmount/remount is not an
  acceptable renewal strategy.
- **Visibility is mutable** and stored as catalog metadata.

## Layout and identity

Each workspace has one drive9 tenant. Each memory is a directory:

```text
/memories/<memoryId>/MEMORY.md       # front matter: name, description; short entry
/memories/<memoryId>/<topic>.md      # further documents, relative paths
```

The path carries no visibility, so switching visibility moves no files. Paths are
document identity, as in the Loro design: renaming moves a file, and a visible
destination is never implicitly overwritten. Search uses drive9 `grep`/`find`
under the memory prefix rather than an in-process scan.

## Access paths

```text
             ┌──────────── hosted credential service ───────────┐
             │ catalog (memoryId, visibility, owner), membership │
             │ holds tenant owner key; issues scoped tokens      │
             └───────┬──────────────────────────────┬───────────┘
          scoped token (memory prefix)     scoped token (memory prefix)
                     │                              │
   daemon SDK client (private + shared)   drive9 mount (shared only)
   MCP tools, prompt injection, RPC       ~/Lody/Memory/<name>, editors, agents
```

- **Private memories.** Only the owner's daemon reads and writes them, through the
  drive9 JS SDK. The SDK needs Node `fs`, so it runs only in the CLI daemon.
  Renderer, Web and mobile clients go through daemon RPC. A private memory is never
  mounted.
- **Shared memories.** These use the same SDK path, with a proposed mount at
  `~/Lody/Memory/<name>`. The mount uses WebDAV on macOS and Windows, and FUSE on
  Linux; drive9's automatic mode selects this. Any member's tools, editors and
  agents can then use ordinary file operations. Whether mounts must ship at launch
  or may follow a tool-only milestone remains open.
- **Role binding.** A Role still binds `{providerId: "lody", memoryId}`, and that
  binding is frozen into each turn. MCP tools receive only the token for the bound
  memory. A mount is outside Role authorization: anything running as the user can
  read it. This is why it is limited to shared memories.

## Credentials

A hosted credential service holds each tenant's owner key and issues short-lived
tokens scoped to a path prefix (`POST /v1/tokens`, `{prefix, ops}`). Tokens are
issued per memory and per user, and can be revoked.

- The daemon keeps filesystem tokens in memory and passes a mount's token through
  `DRIVE9_API_KEY`, with `DRIVE9_VAULT_TOKEN` removed from the child environment.
  Vault tokens authorize secret reads; they are not filesystem-scoped API tokens.
- Lody must avoid writing tokens to `~/.drive9/config`. This alone does not prevent
  credential persistence: default FUSE mount state stores the bearer in a `0600`
  JSON file. Its `--no-persist-credentials` option requires foreground or
  unsupervised operation and is unavailable for WebDAV. WebDAV state omits the
  bearer, but its in-memory client retains the original token.
- Mount credentials are snapshots. The pinned implementation requires
  unmount/remount for renewal, which violates the required uninterrupted mount
  contract. Changing configuration or restarting a supervisor with saved
  credentials does not provide hot rotation. If mounts ship, tested hot rotation
  preserving open handles and pending writes is a release gate.
- Members of a shared memory get `read, list, search, write, delete`.

In this repository the service is an injected `packages/platform` cloud port, and
its DTOs live in `packages/cloud-api`. The OSS desktop is local-only and makes no
authenticated product-cloud requests, so it has no Lody Memory. Whether to support
a user-supplied or self-hosted drive9 endpoint is an open question.

## Changing visibility

- **Private → shared.** Issue member tokens; mount on members' devices if mounts ship.
- **Shared → private.** Revoke member tokens, then ask online daemons to unmount.
  Copies that other members already read, or cached on their disks, cannot be
  recalled. The UI must say so before confirming.

## Provenance and concurrency

- **SDK writes.** The intended contract sets actor and `expectedRevision`, returning
  conflicts without blind retries. Proposed provenance fields are
  `{path, changeId, actor, userId, sessionId, turnId, before/after revision}`
  to explain the current memory, not to require recoverable versions.
  The filesystem token cannot append journals. A file write followed by a separate
  append is not atomic; crash recovery and idempotent reconciliation need a design.
- **Mount writes.** External/unknown attribution is accepted when a source cannot be
  reliably established; changed entries must not retain stale Agent attribution. The pinned
  WebDAV mount never configures `SetActor`, and `X-Dat9-Actor` is caller-supplied,
  not authenticated identity. FUSE generates a mount actor, not the proposed
  `lody:<userId>:<machineId>` identity. Neither establishes trusted provenance.
- **Events.** Filesystem tokens receive 403 from `/v1/events` and `/v1/journals`.
  Owner SSE is tenant-wide; the inspected stream loop does not revalidate expiry
  or revocation. Do not distribute owner keys to daemons to bypass this gap.
  The current recommendation for the Spec is fresh reads on open/use and local
  refresh after writes, deferring live notifications and requiring no SSE. This
  is proposed, not user-approved. If live notifications are later needed, scoped
  events with stream revocation or a membership/path-scoped hosted relay remain
  candidates; neither is implemented or approved here.
- **Concurrent mount writes.** WebDAV buffers whole files and commits unconditional
  writes on close. Its locks are local to each handler, so another mount or SDK
  writer can be overwritten. SDK revision checks protect conditional SDK writes
  only; they do not make subsequent WebDAV writes conditional.
- **History.** Journal append/read/verify works, but does not capture file versions
  or restore them. Revision numbers alone cannot recover overwritten bytes; this
  pin rejects journal artifact references and has no implemented seal operation.
  Recoverable history is not a product requirement or implementation gate. These
  limits still preclude claiming recovery from last-write-wins overwrites. Journal hashes verify
  consistency, not authenticity against an administrator able to rewrite the chain.

## Alternatives considered

- **Keep Loro with E2EE sync.** Rejected. Memories stay opaque to ordinary tools,
  search stays in-process, and release waits on personal E2EE.
- **Mount every memory, including private ones.** Rejected. A mount bypasses Role
  binding and exposes a private memory to every local process.
- **Encode visibility in the path** (`/private/…`, `/shared/…`). Rejected. Changing
  visibility would become a move and break open handles and mounts.
- **One tenant per user.** Rejected. Shared memories would need cross-tenant
  sharing, which drive9 V1 supports only as a snapshot copy.

## Consequences

- The Loro-specific code in `packages/memory` is replaced:
  - document layout, history and JSONPath search;
  - SQLite/IndexedDB persistence;
  - the Renderer replica and its local data channel.
- `packages/memory` places storage behind a `MemoryBackend` interface with a
  drive9 implementation; history-related contracts must be adjusted to the
  current-content provenance scope.
- Daemons advertise `builtinMemory: 2`. Clients reject `1`, so no Loro daemon
  serves the new contract.
- If mounts ship, Lody packages the drive9 CLI as a managed runtime and owns the
  mount lifecycle, including uninterrupted credential renewal.
- Hosting cost and quota are per tenant, so per workspace. Limits must be set
  before release.

## P1 verification before implementation

P1 is not an implementation approval. The pinned integration needs the following
work before it can meet the proposed contract:

| Area | Evidence and remaining gate |
| --- | --- |
| Scoped access | Allowed file reads succeed; sibling reads and root listing are denied. SSE and journals are denied entirely. Fresh reads on open/use and local refresh after writes are proposed instead of live notifications, pending approval; never send tenant owner keys to devices. |
| Renewal | Mount clients retain their initial credentials. If mounts ship, tested hot rotation without interruption or unmount/remount is required; uninterrupted, no-loss renewal is unverified. |
| macOS WebDAV | Scoped macOS mounts read/write successfully, but replacing an existing file with `os.replace(tmp, target)` fails with `EINVAL`. Previously read contents remain readable from cache after expiry/revocation; uncached reads and new writes fail. Arbitrary editor saves are lower priority than Agent tool writes; this limitation remains. Uninterrupted renewal is a gate if mounts ship. |
| Search and concurrency | Literal English and Chinese Markdown searches return the fixture; stale conditional writes return 409. This is not a recall benchmark or protection against unconditional mount writes. |
| Current-memory provenance | Journal permissions and append/verify work; reliable association of current content with provenance remains unresolved. Per-entry provenance is required; external/unknown attribution is accepted. Entry identity, matching and commit consistency still need a design. Recoverable history is not a gate. |
| Hosting | Local tenant readiness took approximately 6.6–9.7 seconds in two successful samples on TiDB v8.5.1. This is not hosted provisioning latency. Hosted price, quotas and provisioning SLA remain unverified; no cloud tenant was provisioned. |

## Open questions

- May a tool-only milestone ship first, or must launch include mounts?
- Should members get a read-only role later? The current decision is read-write
  for all members.

The fresh-read/local-refresh recommendation and deferred live notifications remain
proposed pending approval.

## Verification

Evidence is pinned to [`mem9-ai/drive9` commit
`b866b426ff4ab8d8409c95e77ad0cc946908bcca`](https://github.com/mem9-ai/drive9/tree/b866b426ff4ab8d8409c95e77ad0cc946908bcca).
Executed local HTTP probes used a synthetic tenant and a token restricted to
`/memories/a/`, with a second memory at `/memories/b/`. They established allowed
read 200, sibling/root denial 403, events/journals denial 403, successful
conditional write followed by stale-revision 409, and new-request rejection 401
after revocation. Search ran before overwriting the fixture and returned its path
for both `pnpm` and `中文`. These observations do not establish live stream
revocation, broad search recall, or application recovery.

Reproducible upstream test boundaries:

- `pkg/server/tokens_test.go`: `TestScopedTokenRevokeInvalidatesToken`.
- `pkg/server/server_test.go`: `TestWriteWithExpectedRevisionConflict`.
- `pkg/server`: `TestScopedBusinessEndpointGuardDeniesEndpointsOutOfWorkspaceZonesScope`,
  `TestJournalPermissionsFromClaimsFailsClosedForScopedKeys`,
  `TestParseFSScopeOpsRejectsSearchWithoutRead`, `TestJournalHTTPCreateAppendSearchVerify`,
  `TestJournalHTTPFullEntriesRequireReadPermission`,
  `TestJournalHTTPAppendSourcePermissions`, and
  `TestJournalHTTPSearchOmitsZeroTimesAndSupportsRepeatedLabels`.

These tests executed with a local TiDB database using `go test ./pkg/server
-run '<test-name-regexp>' -count=1 -v -timeout=180s`. The isolated database required
`tidb_ddl_enable_fast_reorg=OFF` and `tidb_enable_dist_task=OFF` to avoid the local
DDL ingest free-space precheck; that setup is not a production recommendation.

A live macOS WebDAV probe confirmed scoped mounts in the OS mount table. API
write → mounted read and mounted write → API read returned matching contents;
API rename → mounted read also worked. Atomic replacement over an existing file
failed with errno 22, leaving the temporary source present. After revocation and
a separate 20-second token expiry, new API requests returned 401, cached mounted
contents remained readable, uncached reads returned ENOENT, and attempted new
writes returned EIO without creating a server file. This does not establish
revocation of dirty/open handles or lossless renewal. Probe mounts were unmounted.
Single local observations were about 59 ms API-to-mount and 183 ms mount-to-API,
including subprocess and verification overhead; they are not latency percentiles
or hosted-service predictions.

Source-only findings additionally rely on `pkg/server/auth.go`,
`pkg/server/sse.go`, `pkg/server/tokens.go`, `pkg/webdav`,
`cmd/drive9/cli/mount_webdav.go`, the CLI mount credential/state code, and
`clients/drive9-js/src/client.ts`. Source inspection is not a live mount or recovery
test. The [memory Spec](../../../../specs/agent-role-memory.md) remains draft.
