# Session run-config drafts survive tab navigation

Status: implemented
Translation: current
PR: [#1287](https://github.com/LodyAI/Lody/pull/1287)

[中文](2026-10-07-session-run-config-drafts.zh.md)

## Abstract

An unsent Fast change disappeared after tab navigation because its owner was the
composer component. The first fix retained every visited session and its Turn
lineage, including sessions with no user edits. The revised design retains only
actual private edited fields and consumes their exact generations at successful
local send admission. Remote Turns update defaults without clearing local intent,
so no history-recognition cache is needed; application restart still loses drafts.

## Decision and ownership

The [draft Spec](../../../../specs/session-run-config-drafts.md) records the selected
private-draft semantics. Effective values remain a pure derivation; a sparse
account/workspace/session map owns only edited fields. Per-mounted selector atoms
and edit leases are released on unmount. A field object's identity is its edit
generation, including repeated same-value selections; there is no lifetime ID
counter or visited-session atom family.

The composer captures only generations represented by the final inputConfig.
The existing `acceptSessionUserTurn` boundary acknowledges both local writes and
attachment-held admission. Its scope-bound callback can consume captured fields
after unmount, while newer edits and programmatic overrides remain independent.
Failure before admission preserves intent. Held-send promotion needs no second
acknowledgment. This follows the [held-send ownership decision](2026-09-30-composer-pending-send-config.md).

Remote Turns never consume local edits. This avoids both the unbounded lineage
union and the missed-acknowledgment case where an intermediate accepted Turn was
hidden by a later one before remount. Keeping that older policy would require
more causal history or observers; TTL/LRU would instead silently lose real drafts.

Confirmed deletion and authoritative account teardown clear drafts and invalidate
mounted edit leases. Sparse bootstrap reconciliation handles deletion while away,
without keeping session documents alive or treating missing metadata as deletion.
Account lifetime identity fences delayed cleanup across sign-out and same-account
re-entry. Navigation and reversible archive retain intent. Unknown Role catalogs
plus manual edits freeze explicit None, avoiding stale Role/memory inheritance.

## Verification and limits

Deterministic tests assert actual sparse-store contents, tab/remount behavior,
explicit off, same-value generations, remote baseline changes, delayed acceptance,
failed admission, deletion, account lifetime changes and streaming identity.
Read-only visits and Turn changes retain no draft rows; actual unsent drafts are
never evicted by a capacity limit. No GC timing, sleeps or network races are used.

The redesigned components suite passed all 4,888 tests across 557 files. A final
narrow legacy-provider target guard was added afterward and passed all 24 metadata
tests, component type checking and changed-file type-aware lint; the full suite
was not repeated after that guard. Repository type-aware lint and the i18n,
code-import, platform and public boundary checks passed. Detailed commands are in
the PR. Full CI in this sandbox encountered unrelated CLI home-directory,
Unix-socket, proxy and WebRTC limits, reproduced on untouched main. Packaged
Electron acceptance is not claimed.
