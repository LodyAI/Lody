# Publish verified PR observations independently of webhook linkage

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1192

[中文](2026-10-01-pr-observation-association.zh.md)

## Abstract

A hosted workspace can discover an existing branch PR through machine GitHub
credentials but still show Create PR because webhook association rejects it.
The proposed correction publishes the authenticated observation independently
and keeps hosted association retryable. It preserves repository/branch and machine
ownership checks and does not grant hosted detail or mutation access. The patch
needs human review of this changed publication contract; production acceptance
and the server's precise rejection reason remain unverified.

## Evidence and decision

Current main still gates discovery publication on the association result.
The reported PR is [#1177](https://github.com/LodyAI/Lody/pull/1177); it addresses
different defects. Read-only diagnostics found repeated association rejection,
an empty owner PR list, and a scheduler target matching the PR's repository and
head branch. Repository-level cooldown was absent at inspection. This establishes
the publication gate as the blocking client path, but not why the server rejected
association or which credential originally created the PR. GitHub App repository
lists alone cannot establish the effective personal credential's read access.

The final main audit is `993cb8c8c`: since the tested `93545f01b` base it merged
#1177 (All Changes bases / image modal focus) and #1187 (search documentation).
Neither changes PR discovery/publication or the info-bar action gate; the open PR
audit found no other B08 implementation. The branch retains its tested base.

Keep hosted webhook association as a separate idempotent effect. Successful
confirmation lives only in the workspace runtime; published metadata is not proof
of webhook linkage. Rejections and transport failures publish the verified winner
while leaving discovery due. Clear a previous context fingerprint on failure so
a newly published terminal PR remains retryable across restart. Normal polling
quota, attempt floors and credential cooldowns continue to apply. Re-read owner
metadata after association and reject publication if its machine, repository,
branch or existence changed.

This partially replaces the hosted association-first decision in the
[local PR observation note](../../implemented/feature/2026-09-24-local-github-pr-observation.md).
Keeping that gate would preserve the observed failure indefinitely. Writing
production metadata or creating another business PR would hide the cause. A
server-side authorization change cannot be implemented or verified in this public
repository and is not part of this patch. The trade-off is a visible summary whose
hosted webhook linkage may still be unavailable; detail and mutation operations
retain their own authorization requirements.

## Verification

Synthetic scheduler fixtures reproduce failed association with managed and ambient
credentials, publish PR/CI metadata, and exercise retry, recovery, terminal restart
and context changes. Five regression cases fail against the unmodified main
implementation. The component test follows compact owner metadata through PR
selection and action gating for root and child views. No captured transcripts or
production fixtures are committed.

The isolated browser acceptance uses the real Session info bar, PR selection and
action gating, with hosted mutations disabled. Metadata captured from the same
ambient-credential / rejected-association fixture on `93545f01b` and the patch is
rendered at 1000 × 640, English, light theme, in fresh Playwright contexts.
Before: no PR, Create PR and a Create Draft PR overflow item. After: draft #55,
compact failed-CI status, Commit & Push, and no creation or hosted mutation entry.
Both screenshots contain only synthetic `owner/repo`, `feat/x` and +12/−3 data;
external HTTP and WebSocket destinations are blocked. The before/after Playwright
case passes, and the images are uploaded to the requesting Lody conversation,
not committed. This is component acceptance, not a deployed full-session UI check.
The reusable browser regression is
`pnpm --dir packages/components exec playwright test tests/e2e/session-info-bar-observation.spec.ts --workers=1`;
optional `B08_SCREENSHOT_FIXTURES` supplies captured `before.json` / `after.json`.

The poller suite passes 193 tests; PR selection/action suites pass 21 tests.
After rebasing onto `93545f01b`, the poller plus command credential-runtime,
Git transport and gh-shim suites pass 266 tests; the 21 UI tests, CLI typecheck
and changed-file formatting checks pass again. Standalone and captured-before/after
Playwright runs each pass one test; components typecheck and changed-file lint pass.
The full CLI suite on the patched `7d502f3d` base passes 3289 tests with four skipped.
Root typecheck and lint,
i18n, formatting and code-collab/platform/public-boundary checks pass. Full
workspace checking is not green: the unchanged `boot-shell.test.tsx` storage
unavailable case also fails when run alone under Node 26.10.0. The component
suite has 4591 passing tests and this one failure; the gate stops before Electron
tests. Repeating `pnpm check` after rebase and browser coverage again passes root
typecheck and lint, then stops on that same component failure (4591 passed / 1 failed).
Documentation checking reports six existing links into uninitialized Kimi/Pi submodules and
no new task-document errors; no protected topics are registered.

Historical CLI 0.102.0 and Web 0.103.0 artifacts have not been fully mapped to source commits;
current main's polling defaults are not evidence of the historical deployment.
No production metadata writes, permission changes, merge or deployment were made.

Contract: [PR observation Spec](../../../../specs/local-github-pr-observation.md).
