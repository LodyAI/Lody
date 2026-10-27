# Rebuild corrupt encrypted discovery only from authenticated online reconciliation

Status: implemented
Translation: current

[中文](2026-10-27-e2ee-catalog-recovery.zh.md)

## Abstract

A corrupt encrypted catalog sidecar kept every encrypted workspace undiscoverable offline even after a successful online workspace listing. The authenticated online-list owner can now archive the corrupt file and rebuild the cache from its current list. The existing account/machine-bound invalid marker stays published until both cache slices are written successfully. Offline reads, ordinary mutations, local provisioning and permission failures cannot grant recovery; original bytes remain available for reconciliation.

## Decision and containment

The catalog is discovery metadata, not ledger or key authority. Ledger, ciphertext and credential formats and signature checks remain unchanged. This follows the [unknown-mode decision](2026-10-27-e2ee-cli-review-fixes.md) and [failure containment](../../../docs/failure-containment.md).

RemoteBridge receives Fleet's authenticated complete workspace list and explicitly marks that provenance when caching. The local provisioning caller does not. Under the existing native FileLocks mutation lease, publication writes the invalid marker, renames only a corrupt `.e2ee` sidecar to a unique `.corrupt-<uuid>` archive, writes the replacement encrypted slice and ordinary slice, then removes the marker. The returned in-memory result drops the superseded corruption error only after recovery succeeds. An unreadable invalid marker or permission failure is not classified as recoverable sidecar corruption.

If archive or publication fails, ordinary remote results and current authorization/revocation handling continue through the existing degraded receipt. The marker prevents encrypted offline startup from adopting stale or partially published rows; another authenticated online list owns the next retry. If the process stops after archiving, the missing sidecar plus marker stays unavailable. No archive is deleted. Unknown content modes remain uncached; account/machine checks and old-client sidecar isolation remain intact. Recovery cannot reconstruct previous access grants or sessions from damaged bytes.

The mutation boundary is already native Effect v4. This change retains its uninterruptible file publication and shared lock; it adds no lifecycle owner or migration dependency. Moving the Promise read-cache orchestration is deferred because it does not help this recovery.

## Evidence and limits

Real temporary files cover initial offline failure, original-byte preservation, authenticated rebuild, refusal by local/ordinary callers, archive and replacement-write failures, retry after failure, account/machine changes and exclusion of unknown modes. A real RemoteBridge/catalog integration applies current revocations while rebuilding, and its test fails if recovery provenance is removed. New recovery assertions fail on the original code; removing archive/rebuild again makes the recovery cases fail. Test locks are confined to each temporary directory. Existing invalid-marker cleanup and ordinary-write containment cases remain in the owning suite.

Local tests and static checks do not establish live cloud authentication, OS-level power-loss durability, Windows file behavior, packaged CLI/desktop behavior or production acceptance. Full repository validation remains CI's responsibility for this task.
