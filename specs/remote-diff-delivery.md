# Remote diff delivery

Status: draft
Translation: current

[中文](remote-diff-delivery.zh.md)

A member viewing another machine's diff should receive only the content needed
for the files they open, and should reuse unchanged content. The owning daemon
remains necessary: a renderer cache does not provide an offline diff service.

Machines advertising `codeCollabDiffBlobs` v1 provide owner-scoped, paged manifests
and raw byte-range blob reads. Every read rechecks the session's read authority;
a content hash alone grants no access. Git bases, retained turn evidence and live
disk are distinct sources. Historical turns never substitute current disk, and
an expired source fails explicitly. Raw bytes must verify against the advertised
content key before decoding or caching, including BOM and newline bytes.

These two methods are pure reads, including for encrypted workspace members with
read authority. They do not start watches, mutate evidence, or claim execution.
Shared file indexes carry only opaque per-path invalidation tokens, never content
hashes that would reveal whether a guessed file body exists. Read-only evidence
access opens an existing recognized database without initialization, migration or GC.

Only ordinary remote workspaces may persist verified blobs in the renderer's
bounded, rebuildable IndexedDB cache. Local and encrypted workspace blob caches
stay in bounded memory; workspace disposal and withdrawal of content admission
clear those caches. A cache hit never establishes current authorization or file
freshness; the live surface must have admission and current manifest identity.

Remote responses have an encoded page budget. Large files may start as partial
patches, with full verified files loaded when the user expands context. A patch
that exceeds its computation or wire budget falls back to full blob reads; only
content exceeding the raw text cap becomes an unavailable/statistics entry. Older machines and
clients retain their existing diff methods; support is negotiated by capability,
never inferred from a CLI version.

The read-authority change, cache-at-rest policy and additive v1 compatibility
contract are the decisions requiring human review. This draft records implemented
intent and does not assert approval.

Evidence: [decision and validation](../.agents/notes/implemented/architecture/2026-10-31-remote-diff-transport.md),
[wire schemas](../packages/shared/src/code-collab-diff.ts),
[daemon](../apps/cli/src/lib/code-collab/code-collab-v2-service.ts),
[client](../packages/components/src/lib/code-collab-session-file-provider.ts).
