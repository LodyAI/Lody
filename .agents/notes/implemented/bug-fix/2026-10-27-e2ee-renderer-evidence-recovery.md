# Isolate damaged renderer evidence without replacing workspace identity

Status: implemented
Translation: current

[中文](2026-10-27-e2ee-renderer-evidence-recovery.zh.md)

## Abstract

One malformed creation intent blocked every pending request for an account, and unreadable sticky identity markers made admission retries ineffective. Creation now isolates each invalid entry and keeps its original bytes. Admission Retry and native ledger entry can restore unreadable markers from the host's independently verified identity, archiving originals first. Readable identity conflicts remain closed and require identity comparison or pairing follow-up; server metadata cannot supply a replacement pin.

## Decision and boundaries

The existing [bootstrap guide](../../../docs/e2ee-workspace-bootstrap.md) owns the flow. This extends recovery without changing ledger, ciphertext, credential or existing evidence formats. Pending requests must match their canonical account/request key. Invalid entries stay in place; exact-key save/clear still refuses corrupt or changed originals. A storage-wide read failure still blocks durability-dependent creation.

The host's existing account/status port reads its retained verified ledger, independently of renderer markers. Recovery checks account before and after status, workspace ID, current UI scope, readable pins, mode proof and observed genesis. No valid conflicting identity is overwritten. Every damaged marker is saved and read back under a separate archive key before replacements begin. A quota failure keeps the originals. Archives survive cache clearing. Existing optional cache repair remains separate from trust replacement.

The host retains its existing status reader; recovery introduces no native lease or new close path. Late UI recovery cannot mutate another account/workspace. A failed recovery remains scoped to that workspace and gives identity comparison/re-pairing guidance. Other workspaces retain their admission rules. This follows the [failure containment guide](../../../docs/failure-containment.md); no new runtime owner or account-wide gate is introduced.

## Evidence and limits

Real jsdom localStorage tests cover damaged/mismatched pending entries beside healthy and new requests, native same-identity restoration and archived bytes, readable conflicts, account switches, and quota failure. The route suite exercises native verified history with damaged renderer markers. New pending cases fail on the original implementation; disabling native recovery makes its new boundary cases fail. Existing runtime/admission/control suites remain relevant. No OS keychain, real pairing, packaged desktop, private cloud composition or production acceptance is established by these local checks. Full repository checks are left to CI as requested.
