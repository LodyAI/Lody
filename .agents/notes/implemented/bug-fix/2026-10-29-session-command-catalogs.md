# Keep project commands in their Session

Status: implemented
Translation: current

[中文](2026-10-29-session-command-catalogs.zh.md)

## Abstract

Sessions using the same machine and Provider previously replaced one shared slash-command list, so opening another project or refreshing capabilities changed both menus. Provider probes now supply only the initial command preview; each Session publishes its actual commands through its existing runtime-config state. An explicit empty list clears the Session menu, while an unreported list keeps the initial preview available. This preserves commands before the first send without starting an Agent or creating a worktree for a draft. The preview describes the probe environment, not the complete command set of a project that has not started.

## Ownership and behavior

- `AgentClient` retains commands from new/load/resume/fork responses and standard command notifications. Replacement clears the previous runtime's observation. Initial state is read directly rather than synthesized as an ACP notification: any notification affects the existing disconnected-prompt replay policy.
- The run-config applier includes the observed commands in its existing Session patch. Buffered command notifications use that same patch path and driving-turn fence. Commands survive later turns of the same ACP session; replacing the runtime does not inherit its list. Lists replace rather than merge, and `[]` is authoritative.
- `useAvailableCommands` uses the Session list when present, including `[]`; otherwise it reads the bound Provider's probe preview. Capability refresh updates the preview without replacing observed Session commands. Drafts retain their pre-send menu.
- Created-session capability writes omit commands. The machine writer preserves the latest matching-runtime preview beside the write, avoiding a read/write gap that could roll back a concurrent refresh. Only probes replace it; a probe without advertised commands writes `[]`. An entry without a confirmed probe list cannot satisfy refresh from cache. Launch-input provenance is recorded by probes, not by Session starts.
- Cache v11 removes only pre-v11 command lists from readable entries because those lists can contain project data. Models and other understood fields remain readable; ordinary capability refresh replaces the old list. There is no workspace-wide Session scan or stored-history rewrite.

The implementation uses the existing Provider cache and Session control state. It adds no project cache, timer, retry loop, draft preparation, or additional process owner. The [probe workspace decision](2026-10-25-acp-probe-workdir.md) remains the reason probes use temporary directories. This changes command ownership within the [capability cache design](2026-09-16-acp-capability-refresh-cache.md), while retaining the [removal of draft preparation](../simplification/2026-10-16-remove-draft-session-preparation.md).

Native Effect migration was assessed in feature/fix mode. Agent startup, Session control publication and the Repo remain unfinished Promise orchestration. Moving these pure projections and field ownership does not complete a native lifecycle unit, so the migration ledger is unchanged.

## Verification and limits

Behavioral coverage exercises startup responses and notification-only startup, current versus detached ACP sessions, authoritative empty lists, same-runtime continuation, replacement, stale-turn rejection and idempotent writes. The real MachineDocument writer verifies probe ownership, independent forced refresh and confirmed empty probe caching. Real Loro documents and the production menu hook verify two projects, peer synchronization and refresh isolation. The existing metadata-only turn test also verifies command publication without manufacturing visible agent output.

The owning suites are `agent-client-authentication.test.ts`, `acp-session-config-applier.test.ts`, `runtime-config.test.ts`, `doc-runtime-config.test.ts`, `session-execution-service.test.ts` and `acp-session-runtime-two-client.test.ts`. Removing the Session menu override and reintroducing project-command writes both fail their behavioral regression tests. Live desktop interaction and a rebuilt Pi managed runtime remain unverified; current check results belong in the PR.
