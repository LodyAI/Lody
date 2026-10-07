# Session run-config drafts survive tab navigation

Status: implemented
Translation: current
PR: [#1287](https://github.com/LodyAI/Lody/pull/1287)

[中文](2026-10-07-session-run-config-drafts.zh.md)

## Abstract

Unsent Fast choices disappeared when the composer unmounted. A sparse in-memory
store now retains edited fields and consumes their exact generations at successful
local send admission. Remote Turns update defaults without clearing private edits.
The narrowed fix isolates provider targets without tracking their metadata transitions;
returning to a target restores its own draft, and application restart loses drafts.

## Decision and trade-offs

The [draft Spec](../../../../specs/session-run-config-drafts.md) owns the contract.
Field object identity represents each edit generation. Mounted edit leases prevent
stale callbacks from recreating deleted intent and are released on unmount. The
capture callback retains the rendered generations used by the final inputConfig;
it works after unmount without consuming newer, even same-valued edits.
`acceptSessionUserTurn` acknowledges both local writes and held-send admission,
following the [held-send boundary](2026-09-30-composer-pending-send-config.md).

Removed provider-transition reconciliation and its asynchronous target comparisons:
target keys already isolate configuration, so no A→B→A retirement policy is needed.
Confirmed deletion still clears owned drafts; workspace re-entry checks only actual
draft sessions because the metadata scan excludes deleted entries. Missing metadata
never proves deletion. Account lifetime fencing protects late cleanup after re-login.
The one-line Role guard remains: undefined permits programmatic inheritance, whereas
explicit None prevents edited configuration from carrying a stale Role/memory binding.

The earlier visited-session/Turn-lineage cache is unnecessary under local-admission
semantics. TTL/LRU would silently lose real drafts; neither is used.

## Verification and limits

Deterministic tests cover remounts, target isolation, sparse state, exact generations,
remote Turns, admission failures, held sends and lifecycle cleanup. Validation of the
narrowed implementation is reported in the PR. Local full CLI checks have unrelated
sandbox home-directory, socket, proxy and WebRTC limits reproduced on untouched main;
no packaged Electron acceptance is claimed here.
