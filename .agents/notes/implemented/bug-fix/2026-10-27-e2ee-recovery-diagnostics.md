# E2EE recovery diagnostics without replacing authority

Status: implemented
Translation: current

[中文](2026-10-27-e2ee-recovery-diagnostics.zh.md)

## Abstract

Corrupt authoritative local history and unreadable trusted pins surfaced as generic ledger or storage failures. Failed finalizers also hid a restart-only resource boundary behind a generic host failure. Hosts now expose distinct safe recovery codes, retain all evidence and keep failed workspace ownership scoped to its workspace. No remote-history rebuild, pin reset or identity replacement is performed; the explicit reset/re-pair UI is owned separately by [#1970](https://github.com/LodyAI/Lody/pull/1970).

## Codes and safe next actions

| Code | Meaning and permitted next step |
| --- | --- |
| `local-history-recovery-required` | Authoritative local record verification or SQLite image failed. A future explicit remote rebuild must verify the complete source against independently trusted genesis AND the original trusted pin, retain damaged originals, drain the same writer and atomically publish the replacement. This code alone grants none of that authority. |
| `trusted-pin-unavailable` | The original trusted pin cannot be decoded. Never use a server head or a newly empty pin as its substitute. If the original cannot be proved, use explicit archive/reset and normal approval/re-pairing. |
| `restart-required` | A finalizer failed after its one-shot Scope closed. Restart Lody to finish releasing encrypted resources; do not clear the failure or construct a second writer. |

Known native unavailability and client-upgrade failures retain their existing distinction. Definite SQLite corruption (`SQLITE_CORRUPT`/`SQLITE_NOTADB`, or node:sqlite primary codes 11/26) is separate from busy/locked/permission I/O. Raw causes stay in main diagnostics. Failed schema initialization closes its newly opened connection before propagating the primary failure. Ordinary transient storage errors remain retryable.

## Containment and ownership

Against main `8529d3cf`, a single workspace close failure does not set account `closeFailed`: other workspaces already remain available. The failure is retained under the failed entry and now explicitly says restart on later reopen. Successful sibling cleanup still runs. Account `closeFailed` arises only after closing the entire account Scope; clearing it cannot revive already-closed custody or prove that a native handle stopped. That safety fence remains, with a clear cause-free restart instruction rather than a generic host error. Quit/sign-out still proceeds under the existing terminal policy.

The existing native host, Scope and Deferred remain owners. Closing joins admitted work before releasing stores; repeated close returns the retained failed receipt. There is no new timer, account/global map or replacement owner. No migration boundary changes.

## Integration and limits

This is the permitted error-code handoff to avoid duplicating #1970's identity/archive ownership and UI. UI mapping of these new codes, remote re-verification/rebuild, real keychains, installed desktop and physical-device acceptance remain outstanding. In particular, this PR does not claim that a healthy original pin alone has already rebuilt damaged history. Signature/pin/fork checks are unchanged; conflicting valid history remains a conflict, never an automatic reset.

Real crypto/SQLite tests corrupt original records, pin rows and entire SQLite images, verify unchanged damaged bytes/pins, open a healthy sibling, and inject an actual history-connection close failure. Account cleanup still cannot authorize replacement and now reports restart. The tests fail with the old implementation; exact checks are recorded in the PR.
