# Preserve Git operation context across HTTP helper redispatch

Status: implemented
Translation: current
PR: [#1476](https://github.com/LodyAI/Lody/pull/1476)

[中文](2026-10-11-git-helper-operation-context.zh.md)

## Abstract

Git clone could reject valid read-only GitHub credentials because its internal
HTTP helper invocation overwrote the wrapper's read context with write context.
The generated wrapper now preserves valid inherited context only for
`remote-http` and `remote-https`. Independent commands still classify themselves,
and unknown commands or invalid helper context retain conservative write probes.
Regression coverage follows wrapper redispatch into credential selection and
uses a real recursive Git clone against synthetic read-only repositories;
production GitHub and Windows are not validated.

## Decision

[Issue #1471](https://github.com/LodyAI/Lody/issues/1471) exposed an implementation
gap in the [identity fallback decision](../architecture/2026-10-03-github-identity-fallback.md).
The read/write access advertisement must match the initiating command: an HTTPS
read uses `list`, whereas a push uses `list for-push`. The fix does not change
credential ordering, owner eligibility, or the prohibition on replaying writes.

HTTP helpers serve both reads and pushes, so adding them to the read whitelist
would incorrectly downgrade pushes. Globally preferring inherited context would
also let an independent push inherit a preceding read. Restrict inheritance to
the two helper commands and accept only `read` or `write`.

The changed decision is synchronous classification inside a generated standalone
Node script. A native Effect migration would require changing the helper's
runtime packaging and process lifecycle without improving this decision; those
boundaries remain outside this fix.

## Verification

The owning suite now evaluates both generated wrapper invocations before the
credential adapter. Read-only candidates reject write advertisements, so the
tests observe successful read transport or failure before any transfer, not
just the assigned environment string. Coverage includes both HTTP helpers,
all existing read commands, inherited write context on a new read, inherited
read context on a push, and missing/invalid helper context. The existing real
recursive clone fixture now refuses receive-pack, closing the gap where its
synthetic identity previously accepted both permissions.

Before the fix, the wrapper-to-adapter read regressions failed with
`credentials_exhausted`. After the fix, all 18 transport tests pass with native
Git on PATH and inherited Git routing removed. Session-owned Git wrappers must
not enter this synthetic fixture. Together with the credential-runtime suite,
27 focused tests pass. Full workspace type checking, lint, formatting and docs
checks pass. `pnpm check` stops at the unrelated preview fixture because this
container cannot listen on IPv6 `::1` (`EAFNOSUPPORT`): CLI results are 4015
passed, 1 failed and 1 skipped; the full workspace test run did not complete.
