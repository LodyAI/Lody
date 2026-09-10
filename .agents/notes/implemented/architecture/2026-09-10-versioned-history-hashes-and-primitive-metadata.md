# Versioned turn hashes and primitive metadata insertion

Status: implemented
Translation: pending

## Abstract

The shared HistoryWriter now inserts new plain metadata as primitives and creates `LoroText`
only for fields that genuinely stream, so a long session stops paying for thousands of
unnecessary text containers. Alongside it, canonical turn hashes became versioned: a stored
cursor without a version is v1, v2 hashes a canonical item form so a sealed tool_call skeleton
and the full call it came from agree, and the session-doc cursor versions its own
`importedTurnHashes` independently of the sync metadata's `replayDigest`. Both changes are
insertion/comparison policies: opening stored history performs no writes, legacy Text and
primitive values keep their representation, and no old payload is reparsed. The sealed-skeleton
feature itself is not implemented here; only the hash and cursor compatibility it needs.

## Problem

Two pressures met in one storage change.

First, the history item catchall used `schema.Any({ defaultLoroText: true })`. Every new string
in a tool call — `toolCallId`, `status`, `title`, `kind`, a `locations[].path` — became a
`LoroText` container. A single tool call could create a dozen containers that never stream, and
their count is what makes a 3000-round session expensive to open and sync. The schema comment
already argued against deep Text inference, but the code did the opposite.

Second, the session-history sync compared per-turn hashes that were produced by different
canonical forms. A legacy document cursor stored v1 hashes while newer sync metadata advanced to
v2, and `markConflict` updates only the metadata. Comparing a v1 cursor against v2 hashes
manufactured a `prefix_mismatch` on an unchanged transcript.

## Storage insertion policy

`historyItemAnySchema` is now `schema.Any({ defaultLoroText: false })`. Ordinary metadata is
stored as a primitive. Streaming fields are declared explicitly in `schema.ts` and keep their
`LoroText`:

- outer `text` (shared by `text` and `thought`) and `markdown`;
- tool-call `content` via a `storageSchema` hint;
- worktree-script `steps` via a `storageSchema` hint.

The nested tool/worktree payload follows the same rule: its catchall is
`defaultLoroText: false` and only the payload fields that stream are declared — tool `text`,
tool `output`, the ACP `content` block's nested `content.text`, and the worktree step
`output`. Everything else at that level (`terminal_command.command`, `args`, `cwd`, diff
`path`/`newText`, `terminalId`, `input` values, `steps[].command`/`status`) is metadata and
is stored primitive. A first version of this change defaulted the whole nested subtree to
`defaultLoroText: true`, which still built Text for every one of those metadata strings and
made the storage goal unfulfilled; the audit caught it. New values are primitive while a
legacy stored `LoroText` keeps its container id on a same-type edit, because the writer
diffs against the stored kind rather than the new schema.

The policy is insertion-only, and the writer enforces that independently of the schema:

- `diffMap` preserves an existing stored representation for a same-type string edit, so a
  legacy `LoroText` keeps its container id and a legacy primitive stays primitive;
- unknown stored keys and untouched opaque items are never rewritten;
- a malformed legacy value (for example `locations` stored as a Map) does not block an
  unrelated field edit, because only authored changes are parsed.

`schema.ts` and `history-materializer.ts` no longer describe the change as waiting on a
`loro-mirror` patch. The pinned 2.3.2 reader carries the text-event optimization upstream; the
`storageSchema` hint is read only by the shared materializer, and history writes go through the
shared HistoryWriter, not `Mirror.setState`.

## Hash versions

`apps/cli/src/lib/local-project-history-sync-service.ts` defines `HASH_VERSION_V1 = 1` and
`HASH_VERSION_V2 = 2`, with new imports materialized at v2. v1 hashed `{ role, items, plan }`
verbatim. v2 canonicalizes each item:

- `tool_call` keeps exactly `type`, an optional string `title`, `kind`, `status`, and
  `locations` — the fields a sealed skeleton keeps — so dropping `toolCallId`, `content`,
  `rawInput`/`rawOutput`, `ref`, runtime annotations, and permission prompts does not change
  the hash. `title: null` hashes like an absent title.
- `text`/`thought` keep only `type` and `text`, dropping derived `spans`.
- every other item drops the same set of volatile keys.

`resolveStoredHashVersion` treats a missing version as v1. The session doc cursor's
`hashVersion` field versions its own `importedTurnHashes`, and `ExternalAcpHistorySyncMeta.hashVersion`
versions the metadata `replayDigest`. They are independent because `markConflict` may advance
only the metadata. When the two differ, the decision recomputes the replay hashes from the
materialized history in the stored version instead of comparing across versions; recomputation
preserves the turn count, so `appendFromIndex` still indexes the materialized history. If a
version mismatch occurs and no replay history is available to recompute, the decision throws
rather than guessing.

The stored-content baseline records the hash version it was computed with, so an old baseline
cannot be read as v2, and existing v1 canonicalization is unchanged. A baseline written before
the field existed has no `hashVersion`: it is v1 when compared with its cursor
(`(baseline.hashVersion ?? 1) === cursorVersion`). Comparing the raw optional value rejected
every genuine old baseline (`undefined !== 1`), which discarded the projected stored history and
reported a normal append as `local_history_has_untracked_suffix`. The version binding still
rejects a real v1/v2 mismatch in either direction (covered directly in the service suite).

## Alternatives and limits

- Relaxing `MessageContentSchema`/turning off write validation to avoid the mismatch was
  rejected: it hides malformed new input instead of versioning hashes.
- Dropping the stored version or reinterpreting a v1 cursor as v2 was rejected: it trades a
  false conflict for silent hash corruption.
- Keeping the nested tool/worktree catchall at `defaultLoroText: true` (the first attempt) was
  rejected: it moved the container growth one level down and left `command`/`path`/`args` as
  Text, so the storage goal was unmet. Nested metadata defaults primitive; only declared
  streaming payloads are Text.
- The sealed-skeleton contract — a reader-side `ref` payload fetch, a `useToolCallPayload`
  hook, and the UI that consumes it — is **not** implemented here. The v2 canonical form is
  forward-compatible with it but is verified only against synthetic fixtures.

No 3000-round acceptance is claimed. This is a storage-insertion and hash-comparison change,
not a windowed-reader or attachment-externalization rollout.

## Evidence

- `packages/shared/src/{schema,history-materializer}.ts`
- `packages/shared/tests/history-storage-policy.test.ts` (new), `history-writer.test.ts`
- `apps/cli/src/lib/local-project-history-sync-service.ts`
- `apps/cli/tests/local-project-history-sync-service.test.ts`,
  `local-project-history-sync-writer.test.ts`
- [Single history writer](2026-09-07-single-history-writer.md) (the owner before this change;
  its "no #359 hash-v2 rollout" line describes the earlier PR's scope, not current behavior)
- Spec: [session history writes](../../../../specs/session-history-writes.md)
- Supersedes the storage-policy portion of PR #443; see the PR body for the exact base/head.
- Follow-up reader work: [ref-only tool_call skeletons in every reader](2026-09-10-ref-only-tool-call-skeleton-readers.md).
