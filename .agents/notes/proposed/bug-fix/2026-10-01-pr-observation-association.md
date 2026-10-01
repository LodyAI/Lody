# Publish verified PR observations independently of webhook linkage

Status: proposed
Translation: current

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

The poller suite passes 193 tests; PR selection/action suites pass 21 tests.
The full CLI suite passes 3289 tests with four skipped. Root typecheck and lint,
i18n, formatting and code-collab/platform/public-boundary checks pass. Full
workspace checking is not green: the unchanged `boot-shell.test.tsx` storage
unavailable case also fails when run alone under Node 26.10.0. The component
suite has 4591 passing tests and this one failure; the gate stops before Electron
tests. The full gate ran on the patched `7d502f3d` base. Documentation
checking reports six existing links into uninitialized Kimi/Pi submodules and
no new task-document errors; no protected topics are registered.

Historical CLI 0.102.0 and Web 0.103.0 artifacts have not been fully mapped to source commits;
current main's polling defaults are not evidence of the historical deployment.
No production metadata writes, permission changes, merge or deployment were made.

Contract: [PR observation Spec](../../../../specs/local-github-pr-observation.md).
