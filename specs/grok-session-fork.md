# Grok session forks

Status: draft
Translation: current

[中文](grok-session-fork.zh.md)

## Scenario

A user continues a Grok conversation in a new session, either at its current end
or after a selected historical prompt turn, including in another working directory.
The original conversation stays available and is not cancelled or reloaded.

## Contract

The Grok adapter exposes standard ACP `session/fork` and Core's version 1
`_meta.lody.forkAtTurn`. Without a target, it copies the persisted conversation.
With an adapter-issued `turnId`, it asks Grok to copy the inclusive prefix through
that prompt turn and its assistant output. A boundary is a native prompt turn,
not an arbitrary text chunk or tool event. Live copies contain the state Grok
has persisted at copy time.

The adapter publishes `_meta.lody.turnId` from native prompt markers in live and
replayed updates. These opaque IDs retain the native prompt coordinate across
adapter restarts; the host must pass them unchanged. Legacy history without a
native marker does not acquire an invented boundary. Native rewind changes the
branch-local coordinate space; callers must use boundaries from current history.

The request's `cwd` belongs to the child. The adapter discovers the source's cwd
through the runtime's paginated session list, then asks the runtime to copy its
own persisted state. It attaches the child without replay, preserving the target
MCP configuration and permission startup policy. Source lookup, copying, and
attachment must succeed before reporting a successful fork. Failures never
silently create a blank conversation or discard a malformed target. If copying
succeeds but attachment fails, the error exposes the created child ID for recovery.

The adapter owns private Grok protocol translation. Core's shared contract and
Lody's host/UI use no Grok-specific fork request or storage format. Forking does
not itself create a git worktree, restore project files, or start a model prompt.

## Evidence and limits

- [Core contract](../packages/acp-extension-core/README.md) and
  [Grok adapter](../packages/acp-extension-grok/README.md#session-forks).
- [Implementation and verification note](../.agents/notes/implemented/feature/2026-09-24-grok-session-fork.md).
- Automated adapter tests use synthetic protocol exchanges. An opt-in native
  probe verifies persisted full/partial copies and source preservation on Grok
  1.0.34 and 1.0.40. Authenticated child continuation, concurrent live persistence,
  and historical forks across compaction have not been exercised end to end.
