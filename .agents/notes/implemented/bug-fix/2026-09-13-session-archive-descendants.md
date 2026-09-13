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

## Ablation and CI follow-up

| Experiment                                                           | Evidence                                                                                       | Decision                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Remove the separate traversal queue; iterate the growing visited Set | All 35 action tests pass, including nested descendants and cycles                              | Keep: one collection owns discovery and deduplication |
| Inline the single-use restore target wrapper                         | All 35 action tests pass, including restore and deletion isolation                             | Keep: remove the obsolete archive-named abstraction   |
| Remove the metadata readiness guard                                  | The cold-cache archive regression fails: archive resolves instead of rejecting before mutation | Reject; restore the guard                             |

CI's Static checks failed on `typescript-eslint(consistent-return)` in the sidebar:
the success callback mixed an empty return with a returned navigation Promise. Making
the callback async and awaiting navigation retains error propagation and passes the
same type-aware lint locally. Non-type-aware lint had missed this error previously.
