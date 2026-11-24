# Agent session archive synchronization

Status: proposed
Translation: current

[中文](2026-11-03-agent-session-archive.zh.md)

## Abstract

Archiving a Lody conversation releases its runtime but can leave the provider's native session active in history. This change mirrors committed archive and restore transitions through an optional Core capability, using the exact saved native identity and owning Provider. Codex and Claude supply native reversible archive. Unsupported agents and failed synchronization remain visible without preventing Lody cleanup. Historical backfill and a persistent synchronization status UI remain outside this change.

## Ownership and ordering

`MessageHandler` observes committed archive metadata and coalesces changes arriving during cleanup. `SessionManager` serializes operations per Lody Session and re-reads machine, Provider, native ID and desired state before mutation. If runtime termination fails, native mutation is skipped and local cleanup records a warning. Its native request, failure notice and Lody document release run as one queued transition; the release re-reads metadata and keeps the document when a restore has committed, because a resumed turn may already hold it. A cold resume waits for a metadata transition already observed for that Session. Ordinary resume has no native archive side effects. Deleted records, foreign machines, missing native identities and superseded states authorize no native mutation. No title or cwd is used to guess identity.

The short-lived ACP connection uses the normal launch resolver, saved Provider environment, Codex account profile and process-use lease. It only initializes and sends the negotiated Core request, never creating/loading a session, asking for permissions or starting a model turn. Launch and requests share a 30-second cancellation budget; the existing ACP owner terminates the process tree before completion. Cancellation also fences the metadata guard before a request is sent. Cleanup failures stay errors, independent Lody document cleanup continues, and a later transition can retry. These children belong to no resident Session, so `SessionManager.cleanUp` aborts every queued transition and joins it within the agent cleanup budget before MessageHandler's final flush; a cancelled archive still records its failure notice.

## Capabilities and alternatives

Core `sessionArchive` v1 declares `mode: native` or `mode: title-marker`. Both archive and unarchive are idempotent and preserve native identity/history. The adapter owns native storage semantics: Codex reuses its session-index mutations, while Claude uses its SDK archive flag without changing titles or enabling AIR negotiation. A title marker does not promise hiding in Claude Code's resume picker. Missing or unknown capabilities produce an explicit Lody-only archive warning; native failure and successful title marking have different notices.

A second Codex app-server client duplicates adapter logic and prevents other agents from participating. Declaring AIR capabilities would opt Lody into a different client's protocol. Direct transcript/SQLite edits bypass provider ownership. The selected narrow Core extension avoids these alternatives without claiming the full listing/state guarantees of ACP archive RFD #2161. Standard ACP is the replacement once both SDKs and adapters implement that complete contract.

Existing session orchestration and ACP launch remain Promise-based. This change reuses their registered shared process boundary rather than claiming an Effect migration across those unfinished dependencies. Core and adapter commits are companion PR dependencies; the adapters temporarily pin the upstream LodyAI Core commit until its release.

## Verification limits

Lody tests cover native/title-marker/unsupported negotiation, exact request identity, stale metadata, serialization, saved Provider selection, cleanup after failure, a restore that supersedes an in-flight archive, shutdown cancellation and its bounded wait, and real subprocess exit on success/cancellation. Adapter tests cover native mutations and the persisted Claude SDK flag, including missing sessions, protocol routing, the Codex subagent mutation guard, a Codex open that starts during app-server startup, and native Claude archive concurrent with an AIR rename. Synthetic native-store integration verifies Codex without model turns. The [Kimi adapter](https://github.com/LodyAI/acp-extension-kimi/pull/27) and [Sorbet adapter](https://github.com/LodyAI/Sorbet/pull/323) use their native archive flags. Their managed distributions require runtime releases with these methods. The broader feature request remains open.

Main PR: https://github.com/LodyAI/Lody/pull/2281. Core contract: https://github.com/LodyAI/acp-extension-core/pull/26.
