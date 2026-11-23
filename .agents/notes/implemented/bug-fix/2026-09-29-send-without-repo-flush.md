# Send without waiting for Repo persistence

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1132

[中文](2026-09-29-send-without-repo-flush.zh.md)

## Abstract

Message admission awaited `repo.flush()` before dispatch, coupling each send to persistence of unrelated dirty documents. The user requested removing this wait. Admission now completes after local metadata, history or queue, and activation commits; existing Repo persistence and transport upload proceed independently. Local acceptance no longer promises crash durability before background persistence finishes. Startup latency in the packaged application has not been measured for this change.

## Decision and evidence

This revises the flush step in [removing the send journal](../simplification/2026-09-29-remove-session-send-journal.md). `writeUserTurn` in `packages/components/src/lib/session-send-delivery.ts` no longer calls `repo.flush()`. New conversations, continuations, queues, guides, and held sends share this write boundary. The write order and RPC acknowledgment semantics stay intact. The [attachment Spec](../../../../specs/session-files.md) records the acceptance and durability boundary.

In the pinned `loro-repo` 0.21.1 implementation, `flush()` drains document, Flock and metadata persistence; document draining includes all dirty documents and repeats when more work arrives. Waiting there can delay an unrelated conversation's dispatch RPC. No replacement fire-and-forget full-Repo flush is added: persistence remains owned by the Repo.

## Validation

`git diff --check` passed. Documentation checks report the same 62 errors as the baseline, with no new errors. This checkout has no installed dependencies; the test command could not start because Vitest is unavailable. Runtime behavior and packaged timing remain unverified. The change intentionally removes an acceptance-time disk barrier rather than claiming local commits are already durable.
