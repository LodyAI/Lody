# E2EE member display directory

Status: implemented
Translation: current

[中文](2026-10-26-e2ee-member-profile-directory.zh.md)

## Abstract

The encrypted workspace ledger previously had no account directory connection, leaving teammates with numbered labels. Cloud composition now supplies an optional workspace profile query while the ledger continues to determine membership, roles and verification codes. The page resolves directory crypto user IDs through verified current members and displays only names and avatars. A slow, failed or stale directory cannot block ledger verification or replace another account's labels. This implements a display contract, without claiming joined-device acceptance or deployed authorization.

## Decision

The public cloud DTO contains the workspace ID and profile entries with crypto user ID, nullable name and nullable image. It excludes account IDs, email addresses, public keys and roles. The cloud adapter binds completion to the same signed-in account and requested workspace. A separate route effect owns profile availability, account/workspace changes, refresh and unmount; failures retain numbered ledger labels, and the next refresh retries.

The page maps profiles through the verified ledger's current crypto user IDs and membership IDs. It never treats a profile as a member or changes role/verification state. Historical removed-member labels remain numbered when no current directory entry exists. The route no longer maps the signed-in account onto the genesis member just because the device has pinned genesis: a joining device can also hold that pin.

Personal pairing and explicit ledger audit remain beside the history page as separate host/runtime capabilities. Combining them with the directory retains both platform type contracts and native operations. Directory completion does not gate either control or alter its eligibility; a genesis pin establishes local ledger continuity, not account ownership or creator identity. Hosts and ledger policy continue to enforce approval authority.

Putting the profile request inside history loading would make optional labels able to fail a valid ledger read. Reusing the ordinary member directory would conflate two permission models. An optional platform method preserves compatibility with older/local compositions and keeps the public desktop local-only. The React effect remains the ownership boundary; moving its dependencies into an Effect service would add scope without improving this independent read.

## Verification and limits

Behavioral coverage checks real verified ledger display with spoofed profile fields, unchanged verification codes and roles, account/workspace reply fencing, failed-directory recovery, and the cloud operation binding. Native custody, joining, hosted backend deployment and real gateway expiration are separate acceptance work. See the [bootstrap guide](../../../docs/e2ee-workspace-bootstrap.md) for current responsibilities.
The combined route regression also keeps pairing/audit children mounted during a failed directory read; their own component/host suites remain separate from this composition check.
