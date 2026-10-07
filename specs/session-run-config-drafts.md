# Private session run-config drafts

Status: draft
Translation: current

[中文](session-run-config-drafts.zh.md)

## Scenario

An unsent Fast choice in an existing session survives switching tabs. Another
device's Turn updates the shared baseline without consuming this device's edits.
This is the direction of [PR #1287](https://github.com/LodyAI/Lody/pull/1287);
this Spec remains draft.

## Contract

- Store only edited fields, scoped to account, workspace, session and agent/provider
  target. Reading a session retains nothing. Effective configuration still derives
  from edits, runtime state, Turn preferences and capabilities.
- Explicit false and same-value selections are edits with new field generations.
  A send captures only generations represented unchanged in its frozen inputConfig.
  Successful local Turn writing or held-send admission consumes those generations,
  even after unmount; failed admission and newer edits are preserved. Later upload
  failure/retry uses the held send's existing frozen configuration.
- Remote Turns do not consume drafts. Ordinary navigation and reversible archive
  preserve them. Switching targets isolates their edits; returning to the same
  target restores its unsent draft. Metadata changes do not discard another target.
- Confirmed session deletion, workspace removal and account teardown clear owned
  drafts and invalidate stale edit callbacks. Delayed cleanup cannot cross an
  account lifetime. Missing metadata is not confirmation of deletion.
- Drafts are memory-only, with no history-ID cache, empty visited-session entries,
  TTL or LRU. Application restart loses them.
- Manual edits with an unknown Role catalog freeze explicit None, preventing
  programmatic sends from inheriting unverifiable Role or memory configuration.

## Evidence

The [decision note](../.agents/notes/implemented/bug-fix/2026-10-07-session-run-config-drafts.md)
records implementation, tests and limits. Shared session protocols are unchanged.
