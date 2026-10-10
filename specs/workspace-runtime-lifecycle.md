# Workspace connection lifetime

Status: draft
Translation: current

[中文](workspace-runtime-lifecycle.zh.md)

When an account or workspace changes, an old connection may still be fetching a
token or acquiring a room. Its result must not become part of the new workspace.
An offline document commit must remain available after normal workspace closure.

## Contract

- RuntimeProvider retires old publication callbacks immediately, cancels unfinished
  initialization, and waits for cleanup before opening the next runtime.
- Failed connection startup releases its resources through the established
  runtime's close path.
- Repeated close calls share one completion. Close cancels token HTTP and prevents
  new attach/reconnect work; late results cannot publish clients or subscriptions.
  It joins owned attach, Meta acquisition and reconnect work before destroying Repo.
- Pausing retries on an offline event is resumable; permanent close is not.
- Repo keeps persistence ownership. Committed offline edits survive the existing
  close path; close does not require remote upload acknowledgement.
- Ordinary stream IDs, storage namespaces, formats and cursor ordering remain
  unchanged. This adds no E2EE mode, keys or cryptographic behavior.

Noncancelable SDK operations must settle before destroying their dependencies;
there is no new shutdown deadline. This covers the selected connection resources,
not every background workflow or held in-memory send in the runtime.

## Evidence

- [Runtime](../packages/components/src/providers/create-workspace-runtime.ts)
- [Tests](../packages/components/tests/create-workspace-runtime-meta-recovery.test.ts)
- [Decision](../.agents/notes/implemented/architecture/2026-10-10-workspace-connection-lifetime.md)
