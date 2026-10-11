# Read public PRs without a hosted repository association

Status: implemented
Translation: current

[中文](2026-10-11-public-pr-details.zh.md)

## Abstract

A recorded PR could be visible while its details failed because the workspace had
not linked the repository. Public repositories now have an anonymous read path for
PR details, reviews and diffs. Hosted repository identity remains necessary for
mutations, and private or mismatched repositories remain blocked. Anonymous quota
and network failures can still prevent loading; live mobile deployment is unverified.

## Decision and evidence

The shared identity hook probes GitHub metadata without credentials when hosted
identity is unresolved. It requires an explicit public flag, matching repository
name, a positive numeric ID and agreement with any existing ID, with no redirects.
The returned ID identifies only public reads, never hosted linkage or write access.
REST helpers omit Authorization for empty-token public reads, including file content.
The PR container omits mutation callbacks; operation dispatch also rejects writes.
Authenticated caches are not reused by public reads. Public CI refresh slows to
five minutes and skips rapid mergeability polling to conserve anonymous quota.

This extends the [observation/association separation](../../proposed/bug-fix/2026-10-01-pr-observation-association.md):
a missing hosted association no longer implies public details are unreadable.
Removing the identity gate globally would permit credentialed writes based on a
name alone, so the public path instead stays anonymous. Existing React hook
lifecycles are retained; no Effect runtime or backend contract changes are needed.
Intent: [PR observation](../../../../specs/local-github-pr-observation.md).
GitHub documents [anonymous public check reads](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
and the lower [anonymous rate limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Verification

Synthetic tests cover public loading without tokens, blocked mutations, private or
mismatched metadata, late responses after navigation, and omitted authentication
headers. The seven targeted suites pass 92 tests. Workspace typechecks and lint,
plus i18n and public/platform boundary checks, pass. `pnpm check` stops on the
unchanged CLI recursive SSH clone fixture (`context_unreadable`; 4036 CLI tests
passed). The final PR container suite passes separately. Documentation checking
reports six existing links into uninitialized Kimi/Pi submodules and no errors in
this change; there are no protected topics. Mobile runtime acceptance remains
unverified. No production data, repository permissions or deployed clients were changed.
