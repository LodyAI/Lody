# Manual key updates and device revocation

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1980

[中文](2026-10-27-e2ee-manual-key-management.zh.md)

## Abstract

The owner chose manual administrator key updates for the availability-first MVP. Encrypted workspace settings expose device revocation and a prominent key-update action; eligible administrator devices see a red dot on Settings. Revocation uses the existing signed ledger command and server projection, while rotation failures retain the previous usable epoch and local edits. Durable candidate, submission and accounting-round recovery prevents ordinary retries, lost acknowledgements or a full staging round from requiring replacement signatures. This is a draft implementation; installed-device and gateway revocation acceptance remain separate.

## Boundaries

Management stays in desktop main. The renderer receives verified public device facts and purpose-bound update/revoke IPC, never keys, arbitrary signing or backend credentials. Eligibility and revocation targets are derived from the genuine ledger; the core rechecks authorization when signing. Ordinary/local workspaces retain their existing settings and do not construct management work. Other workspaces keep their own stores and operation owners.

Settings probes refresh the ledger outside custody locks, retain verified facts offline and notify only the matching account/workspace content owner. Manual success also triggers verified native readback and immediate provider selection, without another mailbox request when the new key is already installed. No room, transport or local queue is destroyed. Late UI/native receipts remain fenced by workspace/account lifetime.

## Durable continuation

The existing EpochPublisher persists its candidate, stages the full envelope set, compares exact remote readback, then submits through LedgerSubmission. Its separate candidate/submission SQLite files are scoped by workspace and signing key. An unfinished result remains visible after the ledger flag clears; the same button resumes installation and acknowledgement before new signing.

A lost candidate can reconcile only the retained submission's exact record after the genuine ledger already proves commitment or conflict; an unchanged parent never authorizes CAS without the candidate. Releasing it requires the observed checkpoint in the genuine feed and, for Committed, the verified installed epoch key. Normal staging/mailbox reception can install committed keys independently of a damaged candidate blob, and installed history can restore older pending keys. CandidateProtector is never bypassed for an unpublished candidate. Unverifiable evidence remains retained with a direct link to personal-device authorization or another eligible administrator; a subsequent genuine conflict releases the old submission without re-signing it. No journal is silently deleted.

Staging rounds are accounting metadata outside signed bytes. A keyed table in the existing native history database persists a random round before dispatch and reuses it after retry/restart. Only the backend's distinct, validated capacity refusal permits persisting a fresh round and retrying the same immutable candidate at the same target epoch. Each click makes at most two staging calls; another full round remains explicitly retryable without an epoch jump or round-count cap. Unknown outcomes never allocate another candidate or round. The feature extends local accounting storage; it does not roll back ledger, snapshot, retained/digest v3, candidate protection or envelope formats.

## Failure containment and evidence

Startup/status never signs a rotation. User actions own finite attempts. The native workspace owns management refresh/ingest and key receipt without re-entering the account lock or closing its own admitted work; account/workspace teardown aborts network work and waits that work before native release. Failures retain originals and leave the old sending epoch usable. Native causes stay in main; UI shows retry, administrator-device, identity-recovery or operator guidance. The existing server validates revoked credentials; this client does not retract already issued gateway JWTs, whose accepted MVP absolute lifetime remains unchanged.

Deterministic regressions use real SQLite/crypto and SDK requests, deliberate storage failures and explicit signals. They cover restart across staging failure and repeated full rounds, candidate damage, post-commit installation failure, terminal acknowledgement, retained-epoch sends, manual-only signing, late UI receipts and account/workspace notification isolation. New behavior is checked with the fix withdrawn before GREEN. Storybook shows the actual settings component and recovery states. These checks do not establish physical-device/keychain, cross-platform packaging, deployed Convex/gateway or end-to-end revocation acceptance.

This implements the manual controls deferred from [the MVP decision](2026-10-27-e2ee-mvp-manual-rotation.md) and composes [nonblocking epoch reception](2026-10-27-e2ee-epoch-receive-barrier.md). It adds no automatic rotation signer or destructive fallback.
