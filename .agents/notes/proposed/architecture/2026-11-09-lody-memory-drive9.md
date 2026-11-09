# Lody Memory on drive9: private and shared memories as files

Status: proposed
Translation: current

[中文](2026-11-09-lody-memory-drive9.zh.md)

## Abstract

The unreleased Loro-based Lody Memory stores each memory in a CRDT document. People
cannot open, index or search that document with ordinary tools, and personal E2EE
blocks cross-device use. This proposal stores each memory as Markdown files in a
hosted [drive9](https://drive9.ai/) file service. A memory is **private** (reached
only through the daemon's SDK) or **shared** (mounted read-write on workspace
members' devices); visibility can change after creation. The trade-offs are that
memory content becomes plaintext on the hosted service, memory works only online,
and the OSS desktop build has no Lody Memory. Nothing here is verified yet; the
[P1 checks](#p1-verification-before-implementation) gate implementation.

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
- **Provenance is required.**
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
- **Shared memories.** These use the same SDK path, plus a mount at
  `~/Lody/Memory/<name>`. The mount uses WebDAV on macOS and Windows, and FUSE on
  Linux; drive9's automatic mode selects this. Any member's tools, editors and
  agents can then use ordinary file operations.
- **Role binding.** A Role still binds `{providerId: "lody", memoryId}`, and that
  binding is frozen into each turn. MCP tools receive only the token for the bound
  memory. A mount is outside Role authorization: anything running as the user can
  read it. This is why it is limited to shared memories.

## Credentials

A hosted credential service holds each tenant's owner key and issues short-lived
tokens scoped to a path prefix (`POST /v1/tokens`, `{prefix, ops}`). Tokens are
issued per memory and per user, and can be revoked.

- The daemon keeps tokens in memory and passes a mount's token through the
  environment (`DRIVE9_VAULT_TOKEN`).
- Tokens are never written to `~/.drive9/config`.
- Members of a shared memory get `read, list, search, write, delete`.

In this repository the service is an injected `packages/platform` cloud port, and
its DTOs live in `packages/cloud-api`. The OSS desktop is local-only and makes no
authenticated product-cloud requests, so it has no Lody Memory. Whether to support
a user-supplied or self-hosted drive9 endpoint is an open question.

## Changing visibility

- **Private → shared.** Issue member tokens, then mount on members' devices.
- **Shared → private.** Revoke member tokens, then ask online daemons to unmount.
  Copies that other members already read, or cached on their disks, cannot be
  recalled. The UI must say so before confirming.

## Provenance and concurrency

- **SDK writes.** Each write sets the actor and sends `expectedRevision`. A
  revision conflict is returned to the agent as a conflict, not retried blindly.
  Each successful write appends a drive9 journal entry:
  `{path, changeId, actor, userId, sessionId, turnId, before/after revision}`.
- **Mount writes.** The mount uses actor `lody:<userId>:<machineId>`. The daemon
  observes these writes through the SSE event stream and records them, attributed
  to user and machine but not to a turn.
- **Concurrent mount writes.** The last write wins; the journal supports recovery.
- **History.** drive9 has no per-file version history, so the journal, together
  with whatever content or revision references it holds, is the history.

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
- `packages/memory` keeps its contracts behind a `MemoryBackend` interface, with a
  drive9 implementation.
- Daemons advertise `builtinMemory: 2`. Clients reject `1`, so no Loro daemon
  serves the new contract.
- Lody packages the drive9 CLI as a managed runtime and owns the mount lifecycle.
- Hosting cost and quota are per tenant, so per workspace. Limits must be set
  before release.

## P1 verification before implementation

1. **SSE scope.** Does a prefix-scoped token's `/v1/events` stream exclude events
   for other paths? If not, the daemon must use a separate credential to watch
   events. This is the largest risk.
2. **Token renewal.** How does a running mount pick up a renewed token without a
   remount or lost writes?
3. **macOS WebDAV.** What are the latency and editor behavior (atomic saves,
   temporary files) on a mounted memory?
4. **Search and concurrency.** How good is `grep` recall on Markdown? Do
   `expectedRevision` conflicts behave as expected between the SDK and the mount?
5. **Hosting.** What do per-tenant cost, quota and provisioning latency look like
   for a new workspace?

Pending question: should members get a read-only role later? The current decision
is read-write for all members.

## Verification

Nothing is verified yet. The drive9 facts above come from reading the
`mem9-ai/drive9` source at commit `b866b426` (2026-11-07):

- `cmd/drive9/cli/mount_webdav.go` (`ResolveMountMode`);
- `pkg/server/tokens.go` (scoped tokens);
- `pkg/server/auth.go` (journal permissions);
- `clients/drive9-js/src/client.ts` (`expectedRevision`, `setActor`,
  `watchEvents`, `grep`).

The [memory Spec](../../../../specs/agent-role-memory.md) remains draft.
