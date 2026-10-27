# Isolate damaged renderer evidence without replacing workspace identity

Status: implemented
Translation: current
PR: [#1964](https://github.com/LodyAI/Lody/pull/1964)

[中文](2026-10-27-e2ee-renderer-evidence-recovery.zh.md)

## Abstract

One malformed creation intent blocked every pending request for an account, and unreadable sticky identity markers made admission retries ineffective. Creation now isolates each invalid entry and keeps its original bytes. Admission Retry and native ledger entry can restore unreadable markers from the host's independently verified identity, archiving originals first. Readable identity conflicts remain closed and require identity comparison or pairing follow-up; server metadata cannot supply a replacement pin.

## Decision and boundaries

The existing [bootstrap guide](../../../docs/e2ee-workspace-bootstrap.md) owns the flow. This extends recovery without changing ledger, ciphertext, credential or existing evidence formats. Pending requests must match their canonical account/request key. Invalid entries stay in place; exact-key save/clear still refuses corrupt or changed originals. A storage-wide read failure still blocks durability-dependent creation.

Recovery first deletes unreadable optional caches and re-reads evidence; readable evidence returns directly to admission without native work. Only unreadable sticky pins/known-encrypted markers use the optional account-bound `readIdentity` port, independently of renderer markers. Recovery checks account before and after that read, workspace ID, current UI scope, readable pins, mode proof and observed genesis. No valid conflicting identity is overwritten. Every damaged marker is saved and read back under a separate archive key before replacements begin. A quota failure keeps the originals. Archives survive cache clearing. Existing optional cache repair remains separate from trust replacement.

Correction: `status` requires an existing reader for this window; a cold recovery cannot use it. The restricted `readIdentity` IPC instead validates the expected account, opens retained verified state under the account lock, and returns only workspace ID/genesis. Existing window readers remain unchanged. Without existing readers, it begins close under the lock and awaits the captured cleanup outside the lock before replying; failure returns no trusted identity. Cleanup remains bound to the captured owner even if the account changes. No renderer status/content capability is granted. An older host lacking this operation fails closed. Late UI recovery cannot mutate another account/workspace. A failed recovery remains scoped to that workspace and gives identity comparison/re-pairing guidance. Other workspaces retain their admission rules. This follows the [failure containment guide](../../../docs/failure-containment.md); no new runtime owner or account-wide gate is introduced.

## Evidence and limits

Real jsdom localStorage tests cover damaged/mismatched pending entries beside healthy and new requests, native same-identity restoration and archived bytes, readable conflicts, account switches, and quota failure. The route suite exercises native verified history with damaged renderer markers. The Electron regression invokes the actual IPC class and renderer repair helper against real custody/ledger files and crypto, using synthetic safeStorage and sender/account integration. It proves `status` rejects before and after cold recovery, originals are archived, subsequent ordinary open succeeds, existing readers remain intact and a different expected account is rejected. The ordinary Gate regression proves optional-cache-only repair retries without native identity access. Both cold IPC and ordinary Gate cases failed before this correction. New pending cases fail on the original implementation; disabling native recovery makes its new boundary cases fail. Existing runtime/admission/control suites remain relevant. No OS keychain, real pairing, packaged desktop, private cloud composition or production acceptance is established by these local checks. Full repository checks are left to CI as requested.
