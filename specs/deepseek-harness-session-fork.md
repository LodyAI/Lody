# DeepSeek Harness session forks

Status: draft
Translation: current

[中文](deepseek-harness-session-fork.zh.md)

## Scenario

A user forks a DSH conversation at its end or after a selected historical turn,
including while the original conversation continues running.

## Contract

The provider advertises standard ACP session fork and Core `forkAtTurn` version
1. Root prompt admission and assistant output carry opaque native `turnId`
metadata. A targeted fork copies the inclusive native event prefix through the
matching ended turn; malformed, unknown and unfinished targets fail without
fallback. An untargeted fork copies the whole observed log only when no turn is
open. Empty sessions may be copied. Earlier ended turns remain forkable during
a later active turn without cancelling or reloading the source.

Native history, including compaction replacements and plugin state, remains
native history. The provider creates an independent root Agent, preserves source
lineage and the prefix's configuration, and uses the requested target cwd and
MCP servers. No transcript prompt or model call is needed. Success requires the
child's native durability checkpoint; failure releases its runtime resources.
Prompt completion also checkpoints the ended source prefix for immediate
cross-process fork reads.
If an artifact may remain after failed persistence, the error identifies the
child for diagnosis rather than claiming it was deleted.

The client supplies display-history copying and Git worktree behavior. Fork
does not roll back files. History without provider-issued turn markers cannot
invent an exact boundary. Native log reconstruction supports pre-compaction
cuts while those raw events remain readable. ACP load/resume and cuts inside
unfinished turns are outside this revision.

## Evidence and limits

- [Adapter contract and validation](../packages/acp-extension-dsh/README.md#session-forks).
- [Implementation decision](../.agents/notes/implemented/feature/2026-10-06-dsh-session-fork.md).
- ACP boundary tests and a pinned native event-store probe cover copying and
  reconstruction; model continuation and actual disk restart remain unverified.
