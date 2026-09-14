# Scope the attachment reporter to PR failures

Status: implemented
Translation: current

English | [中文](2026-09-14-pr-failure-reporter-scope.zh.md)

## Abstract

Daily failure reporting no longer downloads evidence or uploads recordings to an
Issue, but the shared attachment reporter and most of its tests still defaulted to
that unreachable Daily path. The reporter, command, fixtures, and assertions now
describe their sole remaining PR workflow consumer. This removes the dead channel
branch without changing PR attachment validation or manifest behavior.

## Context

The [artifact-only Daily reporting decision](../testing/2026-09-14-daily-failure-artifact-only-reporting.md)
removed the Daily workflow's call to the attachment report generator. The PR
reconciler remained the only caller and always selected the `pr` channel, while the
generator still defaulted to `daily` and most tests exercised that default.

## Decision

The generator and test filenames, exported function, temporary paths, and workflow
invocation use PR terminology. The generator emits only PR markers and subjects,
validates the PR suite directly, and preserves `channel: "pr"` in the manifest for
existing consumers. Attachment ownership checks use PR markers; Daily summary
ownership remains covered separately by the Daily policy tests.

## Trade-offs

Removing the channel switch makes the helper unsuitable for a future shared Daily
attachment flow. Such a flow would require an explicit design because the current
Daily contract intentionally keeps evidence in Actions artifacts.

## Verification

No tests were run for this follow-up at the user's request. Hosted CI remains the
verification boundary for the renamed command and tests.
