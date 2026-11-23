# Versioned turn hashes and primitive metadata insertion

Status: implemented
Translation: current

[中文](2026-09-14-versioned-history-hashes-and-primitive-metadata.zh.md)

## Abstract

New history writes now insert ordinary metadata strings as primitives and create
`LoroText` only for fields that genuinely stream, so a long session stops paying for
thousands of unnecessary text containers. Alongside it, canonical import turn hashes
became versioned: a stored cursor or baseline without a version is v1, v2 hashes a
canonical item form so a sealed tool_call skeleton and the full call it came from agree,
and the session-doc cursor versions its own `importedTurnHashes` independently of the
sync metadata's `replayDigest`. Both changes are insertion/comparison policies wired into
the current shared import planner (`packages/shared/src/session-data/history-import.ts`)
and `applyHistoryImport`: opening stored history performs no writes, legacy Text and
primitive values keep their representation, and no old payload is reparsed. The
sealed-skeleton reader feature itself is not implemented here; only the hash and cursor
compatibility it needs.

## Problem

Two pressures met in one storage change.

First, the history item catchall used `schema.Any({ defaultLoroText: true })`. Every new
string in a tool call — `toolCallId`, `status`, `title`, `kind`, a `locations[].path` —
became a `LoroText` container. A single tool call could create a dozen containers that
never stream, and their count is what makes a long session expensive to open and sync.
The schema comment already argued against deep Text inference, but the code did the
opposite. Measured on unmodified main (375c4c7e): `toolCallId`, `status`, `title`,
`kind`, `locations[].path`, `command`, `args[]`, `cwd`, `terminalId` and step
`command`/`output` were all Text containers.

Second, external history import compared per-turn hashes that could be produced by
different canonical forms. A legacy document cursor stored v1 hashes while newer sync
metadata could advance to v2, and a conflict marker updates only the metadata. Comparing
a v1 cursor against v2 hashes manufactured a `prefix_mismatch` on an unchanged
transcript. After #376 the cursor/replay types, hashing, baseline validation and import
decisions live in the shared session-data port, so the versioning belongs there — not in
a CLI-side duplicate.

## Storage insertion policy

`historyItemAnySchema` is now `schema.Any({ defaultLoroText: false })`. Ordinary metadata
is stored as a primitive. Streaming fields are declared explicitly in `schema.ts` and
keep their `LoroText`:

- outer `text` (shared by `text` and `thought`) and `markdown`;
- tool-call `content` via a `storageSchema` hint;
- worktree-script `steps` via a `storageSchema` hint.

The nested tool/worktree payload follows the same rule: its catchall is
`defaultLoroText: false` and only the payload fields that stream are declared — tool
`text`, tool `output`, the ACP `content` block's nested `content.text`, and the worktree
step `output`. Everything else at that level (`terminal_command.command`, `args`, `cwd`,
diff `path`/`oldText`/`newText`, `terminalId`, `input` values, `steps[].command`/`status`)
is metadata and is stored primitive. The first #584 attempt defaulted the whole nested
subtree to `defaultLoroText: true`, which still built Text for every one of those
metadata strings and made the storage goal unfulfilled; its audit caught it. New values
are primitive while a legacy stored `LoroText` keeps its container id on a same-type
edit, because the writer diffs against the stored kind rather than the new schema.

The policy is insertion-only, and the writer enforces that independently of the schema:

- `diffMap` preserves an existing stored representation for a same-type string edit, so a
  legacy `LoroText` keeps its container id and a legacy primitive stays primitive;
- unknown stored keys and untouched opaque items are never rewritten;
- a malformed legacy value (for example `locations` stored as a Map) does not block an
  unrelated field edit, because only authored changes are parsed.

`schema.ts` and `history-materializer.ts` no longer describe the hint as waiting on a
`loro-mirror` patch. The pinned 2.3.2 reader carries the text-event optimization
upstream; the `storageSchema` hint is read only by the shared materializer, and history
writes go through the shared HistoryWriter, not `Mirror.setState`.

## Hash versions

`packages/shared/src/session-data/history-import.ts` defines `HASH_VERSION_V1 = 1` and
`HASH_VERSION_V2 = 2`, with new imports materialized at v2 by the CLI sync service. v1
hashed `{ role, items, plan }` verbatim; the frozen v1 bytes are pinned by a fixed
fixture (`cc7ec54e…5935` for the canonical test turn). v2 canonicalizes each item:

- `tool_call` keeps exactly `type`, an optional string `title`, `kind`, `status`, and
  `locations` — the fields a sealed skeleton keeps — so dropping `toolCallId`, `content`,
  `rawInput`/`rawOutput`, `ref`, runtime annotations, and permission prompts does not
  change the hash. `title: null` hashes like an absent title.
- `text`/`thought` keep only `type` and `text`, dropping derived `spans`.
- every other item drops the same set of volatile keys.

A documented tradeoff: because v2 excludes the tool payload from identity, a source-side
change that only alters tool output bytes does not by itself trigger a refresh.

`resolveStoredHashVersion` treats a missing version as v1. The session doc cursor's
`hashVersion` field versions its own `importedTurnHashes`, and
`ExternalAcpHistorySyncMeta.hashVersion` versions the metadata `replayDigest`. They are
independent because a conflict marker may advance only the metadata. When the two
differ, the decision recomputes the replay hashes from the materialized history in the
stored version instead of comparing across versions; recomputation preserves the turn
count, so `appendFromIndex` still indexes the materialized history. If a version
mismatch occurs and no replay history is available to recompute, the decision throws
rather than guessing, and the port reports a pre-write refusal.

The stored-content baseline records the hash version it was computed with, so an old
baseline cannot be read as v2, and existing v1 canonicalization is unchanged. A baseline
written before the field existed has no `hashVersion`: it is v1 when compared with its
cursor (`(baseline.hashVersion ?? 1) === cursorVersion`). Comparing the raw optional
value would reject every genuine old baseline (`undefined !== 1`), discarding the
projected stored history and reporting a normal append as
`local_history_has_untracked_suffix`. The version binding still rejects a real v1/v2
mismatch in either direction (covered directly in the service suite).

`HistoryImportCursorSchema` declares `hashVersion` explicitly: Zod strips undeclared
keys at the port boundary, and dropping the version would silently reinterpret v2 cursor
hashes as v1. `applyHistoryImport` computes the projected suffix in the stored cursor's
version and writes the next cursor with the replay's version inside the existing
no-await commit block; a cursor-write failure after the history mutation remains
indeterminate, never rejected.

## Alternatives and limits

- Restoring the old #584 CLI-side hashing was rejected: after #376 the shared port owns
  cursor/replay types, hashing and decisions, and duplicating the rules in the CLI would
  recreate two writers of the same policy.
- Relaxing write validation to avoid the mismatch was rejected: it hides malformed new
  input instead of versioning hashes.
- Dropping the stored version or reinterpreting a v1 cursor as v2 was rejected: it trades
  a false conflict for silent hash corruption.
- Keeping the nested tool/worktree catchall at `defaultLoroText: true` was rejected: it
  moved the container growth one level down and left `command`/`path`/`args` as Text, so
  the storage goal was unmet.
- The sealed-skeleton contract — a reader-side `ref` payload fetch, a
  `useToolCallPayload` hook, and the UI that consumes it — is **not** implemented here.
  The v2 canonical form is forward-compatible with it but is verified only against
  synthetic fixtures. Reader follow-up stays in #586, which this change does not touch.

No 3000-round acceptance, payload-size reduction, or E2E acceptance is claimed. This is
a storage-insertion and hash-comparison change, not a windowed-reader or
attachment-externalization rollout.

## Evidence

- `packages/shared/src/{schema,history-materializer}.ts`,
  `packages/shared/src/session-data/{history-import,loro}.ts`
- `packages/shared/tests/history-storage-policy.test.ts` (new),
  `session-history-import-port.test.ts` (versioned port matrix), `history-writer.test.ts`
- `apps/cli/src/lib/local-project-history-sync-service.ts`
- `apps/cli/tests/local-project-history-sync-service.test.ts`,
  `local-project-history-sync-writer.test.ts` (genuine unversioned v1 baseline upgrade)
- [Single history writer](2026-09-07-single-history-writer.md) (the owner before this
  change; its "no #359 hash-v2 rollout" line describes the earlier PR's scope, not
  current behavior)
- Spec: [session history writes](../../../../specs/session-history-writes.md)
- Supersedes PR #584 (closed unmerged; its CLI ownership predated #376).
