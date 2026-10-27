# E2EE member controls and local removal

Status: proposed
Translation: current
PR: [#1982](https://github.com/LodyAI/Lody/pull/1982)

[中文](2026-10-28-e2ee-member-controls-and-local-removal.zh.md)

## Abstract

The product removal path must revoke access without waiting for a new encryption key. Native member controls submit ordinary records and reuse the existing settings key-update entry. A credential-confirmed whole-member removal stops and drains that workspace before automatically deleting its managed local data. Exact device checks and durable receipts protect a later rejoin from an old response; this is honest-client cleanup, not secure erasure or proof of production acceptance.

## Decision and responsibilities

The owner decision of 2026-10-27 permits Owner/Admin removal, forbids Admin removal of Owner/Admin, and forbids removing the Owner. Only Owner changes Admin roles. UI affordances follow these rules; native verified-ledger policy remains authority. A separate SQLite command journal keeps ordinary member operations independent of epoch publication. Originals precede HTTP; recovery reads back the same bytes and acknowledges only persisted verified history. Capability 1 is declared before tag 10. The existing atomic tag 8 API stays separate.

Removal preserves epoch/commitment and makes rotationRequired advisory. Remaining members keep their retained epoch; an administrator finishes the key update in settings. Failed rotation does not undo removal or gate sending. The settings entry/red dot belongs to the existing key-update implementation; this PR adds no second rotation workflow.

The credential endpoint distinguishes whole-member removal from individual-device revocation. A generic directory/history denial or network failure cannot delete data. The host first compares the originating account, workspace, genesis, signing key and credential against the installed identity and persists a terminal marker. It stops native admission and drains the workspace outside network locks. The account coordinator closes its isolated owner and takes the existing exclusive identity lease before deletion; a busy process lease retains the receipt for retry. A newer identity is spared. No renderer can request arbitrary filesystem deletion or export keys.

Admitted member history uses the host-owned bounded ingest loop, never reacquiring the account lock while logout/close waits for that operation. The renderer retires its own runtime, then independently deletes that window’s repo/cursors and the account/workspace pending-input and high-water rows. It keeps a cleanup marker and one scoped retry receipt until all independent stores succeed. Deletion is excluded from the global runtime-drain receipt; a blocked or failed delete cannot fail the next unrelated workspace, while a successor sharing those databases joins its cleanup. CLI removal fences content, drains execution/document owners, then uses the identity lease and pairing mutex to erase custody, runtime and managed Loro data. User project directories and other workspaces remain. A new invitation/membership generates new device keys; old membership pairing is refused. Public pins and tiny cleanup receipts remain. Offline copies can only be cleared after the client learns the removal; other stopped window namespaces clean themselves when opened. This does not reclaim malicious copies, backups or prior external side effects.

## Alternatives and integration

Waiting for epoch publication would violate removal availability. Deleting by workspace ID alone could erase a later rejoin. Treating every unauthorized response as removal would erase data after an individual-device revoke or account/network failure. Reusing the rotation journal would unnecessarily couple independent member changes to unresolved rotation work.

This independent branch is based on public main and is validated with the core-only overlay from [24-A](https://github.com/LodyAI/Lody/pull/1979). The overlay is not part of this PR. The backend must adopt that core and return the exact member-removal error before product acceptance. The branch composes the settings implementation already merged in [#1980](https://github.com/LodyAI/Lody/pull/1980); verified management state sees the removal hint while both journals retain independent teardown. Shared join glue still needs composition review. Specs remain draft: the old mandatory atomic-removal and paused-send text is replaced with the explicit MVP decision, not marked approved.

## Evidence and limits

Behavior tests use real crypto, native SQLite, deterministic injected failures and explicit completion signals. They cover ordinary role/removal records, retained old epoch, lost-ACK native-owner reopen with identical bytes, exact-incarnation cleanup, credential-only deletion signaling, exclusive-lease retry, shutdown during member history and blocked IndexedDB deletion with sibling availability, machine execution-owner drain, fresh-member keys, scoped IndexedDB deletion, confirmation and terminal UI. New native management/cleanup tests were RED against the base, then GREEN with this implementation and the 24-A overlay. Final affected-suite counts and static checks are recorded in the PR.

Existing content tokens expire within their current lifetime (at most 15 minutes). Active invalidation/disconnection of already issued tokens and long connections is deferred. Real keychains, Windows ACL/native ABI, installed app restart, two physical members/devices, live cloud/gateway token behavior and M5 execution acceptance remain unverified. No merge, deployment, gitlink adoption or release is implied.
