# Composer provenance during attachment preparation

Status: implemented
Translation: current
PR: [#1160](https://github.com/LodyAI/Lody/pull/1160)

[中文](2026-09-30-composer-pending-send-config.zh.md)

## Abstract

A held attachment send has frozen input before history publication. Its pending row
preserves that input and supplies Role/MCP provenance while the document hydrates.
Current run configuration belongs to the execution owner; the
[configuration decision](../architecture/2026-10-31-session-config-ownership.md)
replaces the former held-send mode/model/options baseline.

## Decision

`useSessionPendingConfig` subscribes to the latest frozen entry for one session,
not attachment progress. A written entry remains the provenance source until its
Turn appears; cancellation releases that source. A newly observed durable Turn
permanently supersedes an older local source, even if the newer Turn is removed.
Scope includes session and pending-send store.

The logical Turn key survives held-to-history/queue handoff. Private run-config
edits are consumed only by their own admission receipt, not this provenance fence.
Freezing the entire composer would prevent editing the next draft; simplifying its
face would lose ACP-only model and Role labels. Existing faces remain available.

The attachment Spec owns [send admission](../../../../specs/session-files.md#61-send-boundary).
Behavioral tests use the real pending-send store and controlled preparation promises
for publication lag, cancellation, next-draft edits and session isolation. They do
not establish packaged-device or live-provider acceptance.
