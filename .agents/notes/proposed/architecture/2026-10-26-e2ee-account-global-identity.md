# Account-global public E2EE identity

Status: proposed
Translation: current
Date: 2026-10-26
[中文](2026-10-26-e2ee-account-global-identity.zh.md)

## Abstract

Creating a workspace previously generated a new crypto user ID each time. The
approved account-global identity is now obtained from the authenticated control
service before signing, and pinned in a separate account-scoped immutable JSON file. Network work stays outside the account custody lock; account and authentication
generation are checked before retaining the response and again before signing.
Existing workspace opens and exact signed creation retries remain local. This is
ownership metadata, not permission or a proof binding an account to a signing key.

## Responsibility and failure boundary

The narrow cloud client has one fixed registration action with no caller-selected
ID. Bootstrap never generates a crypto user ID; missing identity blocks only a new
signature. The file uses the existing cross-process creation mutex, without changing
device/epoch/creation formats. Complete, fsynced temporary bytes are published with
an atomic non-overwriting hard link and read back. This does not claim directory
power-loss durability; a missing cache is obtained again from the same registry.
Conflicting IDs and unsupported/symlink inputs fail closed without replacement.
Temporary cleanup failures keep the valid published result and the reserved pending
path for the next cleanup pass. Quiesced descriptors whose close fails remain owned
by the process cleanup set; retry and scope cleanup do not poison unrelated work.
The unpublished experimental SQLite candidate is neither opened nor migrated.
Logout/account switch owns client cancellation; late responses also fail the auth
generation fence, including same-account logout/login. No renderer secret/ID input
or normal-workspace registration path is added.

The backend must deploy first. Previously reserved signed records remain exact;
new incompatible unreserved developer intents are rejected before external writes.
The renderer removes only its resumable intent after the exact
`e2ee_account_identity_conflict` refusal, allowing another creation. The host keeps
the signed genesis, keys and original request; an existing exact server receipt is
reconciled before registration checks. Unknown outcomes remain saved. There is no
automatic migration or key replacement. PR22 product
JoinRequest signing remains unimplemented; future callers must use this same
registration before signing rather than invent account identifiers. No iroh,
clock-recovery or Web/mobile capability is introduced.

## Verification scope

Synthetic authenticated custody, real files/SQLite and crypto cover multiple workspace
genesis identities, reopen, conflicting registration, write failure, retained old
originals and authentication-generation races. Real child-process exits cover both
sides of file publication; short reads, lost publication acknowledgments, failed
unlinks and closes retain results, primary errors and cleanup responsibility. Backend tests exercise real handlers
with fixture transactions; their serialized concurrent-registration fixture is not
an independent Convex OCC-engine test. OS keychains, installed apps and deployed
concurrent requests remain acceptance work. The caller uses the existing Effect
resource model; no new lifecycle migration unit is introduced.
