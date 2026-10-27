# Explicit local encrypted identity recovery

Status: implemented
Translation: current

PR: [#1970](https://github.com/LodyAI/Lody/pull/1970)

[中文](2026-10-27-e2ee-local-identity-reset.zh.md)

## Abstract

Damaged device, credential, protection or pairing originals could leave an encrypted workspace permanently unable to pair. Explicit reset now drains its owner and renames the complete local identity directory to a timestamped archive, preserving evidence and requiring fresh approved pairing. Desktop custody, journals and runtimes are isolated by workspace; account-wide archival remains available for permanent OS protection loss. There is no automatic protection downgrade, remote revocation or replay of archived unsent work. Synthetic native tests establish local behavior, not real-keychain or packaged two-device acceptance.

## Decision and ownership

The owner chose explicit recovery for MVP, without compatibility for earlier developer-only layouts. Ordinary retries still preserve originals under the [pairing recovery decision](../bug-fix/2026-10-27-e2ee-local-pairing-recovery.md). Reset neither cancels uncertain remote admissions nor revokes old signatures. A new identity needs approval by another authorized device. Renderer genesis pins, observed checkpoints and mode evidence remain unchanged.

`lody workspace reset-identity <workspace-id> --confirm` prints a UUID before dispatch; `--reset-id` retries an uncertain result. Fleet validates the account, machine and encrypted workspace, fences new starts/preparation, joins admitted activation/start work, and drains only the affected runtime. Cleanup failure retains existing owners. Other processes hold shared native SQLite identity leases; reset needs an exclusive lease in a stable sibling file outside the renamed directory. Busy locks refuse immediately and remain retryable; actual close/process exit releases ownership, without PID/age takeover.

Same-volume rename preserves device, credentials, protection, binding, journals, SQLite sidecars and runtime directories. An immutable receipt records the archive destination and original directory inode before rename; a separate completion marker prevents delayed plans from acting on replacement directories. Desktop receipts live outside account directories so they survive broader account archival. Retrying an interrupted move completes it; retrying a completed reset returns its receipt without stopping a subsequently paired identity. A partial receipt fails visibly and a new explicit reset can recover. No original is deleted. Archive retention is deliberately unbounded until a separate user-requested evidence-management policy exists.

The desktop account coordinator retains independently scoped owners under `identities/<workspaceId>`, each with a KEK, device, credential, bootstrap journal and runtime. Pending creation owners live under `pending/<requestId hash>` and move intact after server publication. A retained request-to-workspace receipt keeps creation retries on the same signed originals. Workspace reset closes only that owner; account reset attempts independent cleanups then archives the whole account directory, including pending creations. Native operations stay with the old Scope until actual completion, and failed close forbids unsafe replacement. The new filesystem/lease leaf is native Effect; migrating remaining Fleet/IPC Promise orchestration would pull in unfinished owners and is deferred.

Explicit machine reset also archives the full desktop approval row (material/request/record), records its reset UUID and selects a fresh consent session. It does not pretend to undo a signed remote admission. Normal preparation/activation schemas remain unchanged; the archive route is separate from remote pairing work.

## Failure and UI policy

`permissions` means repair owner-only access and retry: POSIX directories 700/files 600 or owner-only Windows DACL. Missing KEKs/selectors/OS secrets and missing/corrupt identity originals offer explicit reset; surviving originals forbid automatic replacement KEKs. Locked/unavailable OS protection first offers unlock/start Secret Service or KWallet and retry. Opaque native decrypt failure cannot distinguish locked from lost, so copy explains both retry and explicit account archival. Desktop personal identities always require OS protection. A previously OS-protected or unknown-protection CLI identity still requires OS protection after reset; an explicitly file-protected machine may retain that class. Ordinary first machine creation keeps the earlier approved selection policy.

Controls appear at native ledger-open, personal join and local-agent preparation failures. Confirmation explains the affected scope, evidence retention, unsent work, fresh approval and lack of revocation. Read-only verified history stays available when custody is unavailable. Genuine genesis/mode and verified-history conflicts retain their independent protections. The old shared developer layout is not imported or migrated; account archival preserves it if present.

## Evidence and limits

Real file/crypto tests damage credentials, devices, KEKs, selectors and material journals. Ordinary pairing fails first; explicit reset preserves every surviving byte, then new preparation has independent signer, credential, KEK and journal. Lease contention refuses archival. Removing reset makes all six recovery cases fail. Desktop tests use authenticated synthetic OS wrapping with real crypto/SQLite and verify creation handoff/exact retry, workspace archival, sibling availability, idempotent replay and account archival while native protection is unavailable. UI tests require reset confirmation and new pairing approval; permission repair has no destructive shortcut.

Checks cover affected CLI, Electron, core, shared, platform and renderer paths. Real OS keyrings, Windows ACLs, installed desktop lifecycle, physical multi-device and remote pairing composition, and production deployment remain unverified. Archives may contain unsent data and still-valid encrypted old credentials. This does not enable M5 or unsupported plaintext channels.

The #1954 composition preserves workspace-scoped custody while forwarding ledger-only `installKeys: false` refreshes through the desktop bridge. Key reception keeps both staging and mailbox adapters; reset does not restore the former epoch send barrier. #1966 retains its independent authenticated catalog rebuild and temporary test-lock ownership.
