# Archive the descendants shown under a conversation

Status: implemented
Translation: current

[中文](2026-09-13-session-archive-descendants.zh.md)

## Abstract

Archiving a conversation left its opened descendants active despite presenting them
as one sidebar tree. UI and CLI now share a recursive archive selector covering Tabs
and opened Sessions. The UI rejects archive until metadata hydration completes, so
it cannot silently archive only part of the known tree. Restore and permanent deletion
retain their narrower containment targets; descendants keep independent workspaces.

## Decision and evidence

This partially supersedes the archive decision in
[containment lifecycle](2026-09-10-session-containment-lifecycle.md), while preserving
its deletion and provenance guarantees. See the revised draft
[relation contract](../../../../specs/session-relations.md).

The selector indexes containment or precise opener links, traverses descendants once,
and guards cycles. Root-route provenance alone is not an ownership edge. UI closes
terminals and writes archived/idle state for the selected tree; CLI writes the same
state and MCP delegates to CLI. Existing daemon reconciliation handles resources.
Repeated archive repairs a partially archived tree. Multi-document writes remain
nontransactional, and recovery is an explicit retry.

The owning hook and CLI suites cover descendants, Tab openers, unrelated Sessions,
cycle/idempotency, incomplete metadata, and preservation after root deletion.
Restore stays separate to avoid reviving independently archived work. Its existing
metadata-readiness gap remains outside this change.

## Validation

The hook suite passed 35 tests and the CLI command suite passed 66 tests. Shared
package type checking, changed-code lint and document checks passed. Sidebar archive
failures now display an error and navigation waits for successful completion.
