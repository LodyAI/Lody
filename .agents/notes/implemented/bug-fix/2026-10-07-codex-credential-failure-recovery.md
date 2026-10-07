# Preserve Codex authentication failures and durable credential cleanup

Status: implemented
Translation: current

[中文](2026-10-07-codex-credential-failure-recovery.zh.md)

## Abstract

A failed Codex API-key save or verification could be reported as a credential
deletion failure because rollback threw before propagating the original error.
Failure handling now attempts deletion without replacing that error and leaves
the inactive generation record for the existing cleanup reconciler. The previous
active key remains usable, and cleanup survives restart without a new queue or
metadata rollback. Behavioral tests and ablations support this smaller recovery
path; the separate native-loading defect observed in a Nightly artifact still
requires correction in the build that produced it.

## Cause and ownership

The [account-profile decision](../../proposed/architecture/2026-09-26-codex-account-profiles.md)
and [draft Spec](../../../../specs/codex-account-profiles.md) require host-owned
system-vault API-key generations. Commit `df03b280c`
([#1027](https://github.com/LodyAI/Lody/pull/1027)) introduced the
[profile store](../../../../apps/cli/src/agent/codex-profile-store.ts) and vault.
Staging persists the candidate name before saving its secret, but does not change
the active generation or readiness. Verification must succeed before activation.

Previously, failure handling awaited credential deletion, restored the old
metadata snapshot, and then rethrew the primary error. A deletion failure replaced
the primary error. A restoration failure could do the same, while restoring a
snapshot after failed deletion would forget a potentially stored credential.

The macOS arm64 Nightly 0.104.0-nightly.4 artifact supplied an actual double failure:
its bundled CommonJS keyring wrapper executed bare `require` calls inside an ESM
chunk. Loading failed with `require is not defined` in the cause chain; both save
and rollback deletion returned generic vault errors. The staged native package
2.1.0 loaded directly under Node and the app/helper runtime, and synthetic
save/read/delete/repeated-delete succeeded with external loading. Verification
was never reached through the broken loader.

The public [Vite configuration](../../../../apps/cli/vite.config.ts) already keeps
`@napi-rs/keyring` external. Package presence and CLI startup do not exercise this
lazy credential path. This source fix preserves failure recovery but does not
repair the installed artifact or establish that the current public build has the
same bundling defect.

## Recovery decision and simplification

Keep eager deletion as best-effort cleanup and always rethrow the original error
object, including cancellation. Leave the candidate generation in metadata even
when eager deletion succeeds: deletion of an absent credential is idempotent, so
the existing reconciler can finish the record cleanup later. A failing or partially
successful vault write therefore cannot leave an undiscoverable credential.

No metadata rollback is necessary because staging never activates the candidate.
The [existing coordinator](../../../../apps/cli/src/lib/provider-setup-manager.ts)
already scans profiles, logs a bounded cleanup-pending diagnostic, and schedules
another scan after cleanup failure. Reuse that behavior without new exception
types, retry fields, queues, or services. A one-off artifact-layout parser used in
the investigation is excluded from the maintained patch; the regression suite
owns the durable recovery contract.

## Verification and ablations

The [owning suite](../../../../apps/cli/src/agent/codex-profile-store.test.ts)
now has 19 behavioral cases. Six added cases cross save, verification, and
cancellation failures with pending and ready profiles while deletion also fails.
They assert the original error, preserved readiness and active key, retained
metadata through restart and failed reconciliation, eventual cleanup, and a
successful retry. The save fixture stores the synthetic secret before throwing
to cover partial writes. Another case covers reconciliation after eager deletion
has already removed the candidate.

Ablations replace only the failure branch during test compilation; source files
remain unchanged between experiments. Each runs the same 19-case suite.

| Variant | Result | Observable regression or decision |
| --- | --- | --- |
| Final recovery | 19 pass | Original errors and restart cleanup are preserved. |
| Remove the deletion error guard | 6 fail, 13 pass | Cleanup failures replace the primary errors. |
| Restore the old metadata even when deletion fails | 7 fail, 12 pass | Pending cleanup is forgotten; the candidate cannot be reconciled after restart. |
| Remove eager deletion | 2 fail, 17 pass | Rejected secrets remain until a later scan. |

An earlier guarded rollback with metadata restoration also passed its 19 cases;
removing the restoration kept them passing. The final suite directly verifies
that retaining an already deleted candidate is safe. Eliminate that extra write
rather than add another error guard around an unnecessary operation.

The owning suite, credential-broker suite, and provider-setup suite pass together
(38 cases). Before submission, workspace formatting, type checking, and lint also
pass; the full CLI suite reports 3,499 passing and four skipped tests. Tests use
synthetic secrets, temporary directories, injected failures, and explicit abort
signals.

Root `pnpm check` stops at the unrelated boot-shell storage-unavailable test on
Node 26.10.0. An isolated run in clean main `1417cf879` reproduces that same
failure. I18n, import, platform-boundary, and public-boundary checks pass when run
separately. Documentation checking reports six existing links into unavailable
Kimi/Pi submodules. No Windows/Linux run, full desktop UI automation, or repaired
release-artifact validation is claimed.
