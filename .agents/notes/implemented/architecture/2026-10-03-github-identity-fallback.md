# Replace the live GitHub policy gate with ordered credential fallback

Status: implemented
Translation: current

[中文](2026-10-03-github-identity-fallback.zh.md)

## Abstract

The live identity-policy gate blocked native Git and gh when Lody's credential
service was unavailable. Managed sessions now use a trusted local owner snapshot
and try personal, eligible machine and repository App credentials once in order.
Acquisition failure advances the chain and records a safe, attributable cause;
there is no policy RPC or broker recovery loop. Native Git uses read-only access
advertisements before transferring, while gh never replays compound or uncertain
writes. Production GitHub and Windows end-to-end behavior remain unverified.

## Decision and trade-off

The [draft contract](../../../../specs/github-identity-fallback.md) replaces the
fail-closed-on-policy-outage decision in
[policy recovery](../bug-fix/2026-10-01-github-policy-recovery.md).
Lower-priority credentials may have broader rights. This is the requested
availability policy, not evidence that the original identity-service fault is fixed.
Machine eligibility still comes from matching trusted conversation/machine owners;
service failures cannot grant eligibility. Network identity belongs to the
conversation owner; turn-specific commit attribution is unchanged.

A permanent native bypass would lose personal/App priority, and more retries would
retain the cloud gate. The shared iterator instead separates optional token
acquisition from native execution. Successful tokens have a bounded 60-second cache,
partitioned by owner, machine, repository and source; failure is not cached.
Revocation/configuration propagation during disconnection remains eventual.

Git uses native HTTP-helper adapters in GIT_EXEC_PATH, with ordinary URLs and
native recursive submodule support. Native distribution support files are exposed
alongside the adapter so Git shell subcommands continue to work. SSH normalization
preserves explicit port 443 for the machine candidate. The implementation refines
the initial no-preflight proposal: native upload/receive-pack advertisements are
needed to reject candidates before any push effects. No REST permission model or
custom remote protocol is retained.

gh keeps the existing target/flag parser to avoid routing credentials to an
incorrect repository. It executes native commands directly; only known no-output reads
or definitively rejected single REST requests can advance. Compound writes stop
with their native result, even on an authorization-looking error, because an
earlier internal request may already have succeeded.

Broker errors expose safe codes and correlation IDs rather than swallowing causes.
Host snapshots remain usable if token service startup fails. Concurrent starts
share one attempt; no health timer or self-recovery loop remains. This does not
repair unrelated MCP availability or completion-hook contracts.

## Verification and limits

Owning suites cover candidate order, cloud outage with eligible local success,
non-owner exclusion, source/owner cache partitioning and expiry, native recursive
SSH cloning against synthetic local repositories, receive-pack advertisement
without ref writes, checkout-time credentials, owner stability across participants,
gh REST fallback and compound/partial-write non-replay. The final CLI suite passes 3425 tests (4 skipped) across 302 files; CLI bundling,
workspace typechecking, lint and platform/public boundary checks pass. Test processes
use NODE_ENV=test and GIT_CONFIG_COUNT=0 to isolate inherited session routing.
Documentation checking retains six pre-existing links into uninitialized Kimi/Pi
submodules. No production deployment is performed.

Synthetic fixtures do not prove hosted backend behavior. The public client still
uses the existing source-specific token RPC; server-side policy/refresh behavior
is outside this repository. Existing running agents need refreshed host environment
and context files. Legacy explicitly stored custom remotes need migration to
standard URLs. Windows execution and live GitHub validation remain open.
