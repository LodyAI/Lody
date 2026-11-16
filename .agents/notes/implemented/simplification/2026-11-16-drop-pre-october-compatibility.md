# Drop compatibility for clients and state from before mid-October 2026

Status: implemented
Translation: current

[中文](2026-11-16-drop-pre-october-compatibility.zh.md)

## Abstract

Several removals between September and mid-October 2026 left one-time migrations
and decline handlers so that older desktops, daemons and local state kept working
through an upgrade. Their own notes said to delete them once no supported build
could still produce the old requests or data. On 2026-11-16 the owner chose to
remove them together rather than keep each one open-ended. A daemon now rejects
requests only pre-2026-10-16 desktops send, and the one-time readers for state
written before then are gone. The cost falls on machines that skipped every release
for a month: leftover worktrees from old drafts are no longer swept, and an old
desktop talking to a new daemon gets an unsupported-request error. Persisted
formats that current clients or shared documents still carry were deliberately kept.

## Decision

The following compatibility code is removed:

- **Draft preparation requests.** `session/prepare` and `session/prepare-cancel`
  no longer have daemon handlers; the [preparation removal](2026-10-16-remove-draft-session-preparation.md)
  had kept them as instant no-op answers for older desktops.
- **Code Collab v1 host start.** `session/code-collab-host-start` no longer has a
  daemon handler; no current desktop or Web client sends it.
- **Speculative worktree recovery.** `legacy-speculative-worktrees.ts` and its
  Session-creation claim and startup sweep are deleted. Markers and worktrees that
  a pre-2026-10-16 daemon prepared are no longer adopted or removed.
- **Send-journal migration.** `legacy-session-send-migration.ts` and the
  `force-cache`/`force-all` clear-flag values are deleted. No tagged desktop release
  ever shipped the `lody-session-send-v1` journal (it existed only between 2026-09-15
  and 2026-09-29); the [journal removal](2026-09-29-remove-session-send-journal.md)
  had scheduled this deletion "a few releases" later.
- **PR poller JSON import.** The one-time import of `pr-poller-state.json` into
  SQLite is deleted. A machine that still has the file starts with fresh poll
  quotas and cooldowns once; PR status itself lives in Session metadata.
- **Pre-v1 managed-runtime metadata.** Install metadata without the current schema
  is a cache miss. The worst case is one runtime download.
- **Unassociated quota reservations.** Schedule ids from the `claude-quota-continue`
  v1/v2 shortcuts are no longer recognized and blocked. These were one-time
  schedules due at a five-hour quota reset before 2026-10-31; the Turn-associated
  handoff in the [quota reservation decision](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.md)
  is unchanged.

## Kept on purpose

- Loro session and machine meta legacy fields and `normalizeLegacyAcpSessionConfig`:
  old Session documents are shared history and keep those shapes indefinitely.
- The daemon's discard of `needToArchiveSessions`: mobile builds that already
  shipped still write it, even though current mobile code stops writing it.
- The turn-diff store's legacy schema recognition: that local cache format shipped
  in tagged releases, and without it an old database fails with "unknown schema".
- Fallbacks that depend on the private backend (`legacy-unclassified` workspace
  admission, PR rows without `repositoryId`, `includeVersion` and `historyBatch`
  fallbacks): they need a backend backfill or deployment before removal.
- E2EE wire and storage formats, which may not change once shipped.

## Alternatives

- **A fixed support window per item.** Each note named its own condition ("once no
  supported daemon can produce them"), but Lody has no recorded minimum client
  version, so none of the conditions could ever be checked. One dated cut keeps the
  decision explicit.
- **One-time cleanup instead of deletion for the worktree sweep.** Keeping the sweep
  would remove orphaned worktrees on machines that never upgraded, but it kept about
  600 lines and a startup scan for state that a current daemon never writes.

## Consequences

- An orphaned worktree from a pre-2026-10-16 draft stays on disk until the user
  removes it. The branch and conversation are unaffected.
- A desktop older than 2026-10-16 paired with a new daemon sees an error when it
  sends a draft preparation; it no longer receives a silent `duplicate`.
- Reintroduce a compatibility path only with a recorded minimum supported client
  version, so its removal condition can be checked.
