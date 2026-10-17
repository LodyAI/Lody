# Daemon-hosted MCP workspace commands

Status: implemented
Type: architecture
Translation: current

[中文](2026-10-16-daemon-hosted-mcp-workspace-commands.zh.md)

## Abstract

In the cloud composition, every Lody MCP tool call that touched a workspace opened a complete second replica in the MCP process: a Loro repo, a Streams transport, a token provider and a presence subscription. The process then tore all of it down when the call ended. Releasing presence needs network I/O within a five-second budget, so ordinary slow networks made cleanup fail, and the failure was retained as a fence: every later command for that workspace in the long-lived MCP host failed with `INTERNAL_ERROR` ("Workspace cleanup failed" / "Workspace presence operation failed") until restart. MCP workspace tools now run in the daemon against its existing replica in every composition, as OSS already did, and a failed release no longer blocks the workspace anywhere. Standalone terminal `lody` commands still open their own short-lived replica; packaged-app and live-cloud acceptance remain untested.

## How the defect was assembled

Each step was reasonable alone; together they made a cleanup error permanent.

| Change                                                                                                                                                              | Effect                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Public history (2026-08): `withWorkspaceManager` builds a one-shot `LoroDocumentManager` per command                                                                | Each command creates and destroys a replica, including presence                           |
| #1133 (2026-09-29): `session/call-tool` runs Session tools in the daemon                                                                                            | OSS only; the cloud composition kept the one-shot path                                    |
| `e0ad6d4` / `2263513` (2026-10-12): the native presence registry allows one owner per workspace and refuses a replacement while the previous release is unconfirmed | One failed release refuses every later owner                                              |
| #1560 (2026-10-14): overlapping commands share one manager, and a failed cleanup with unreleased presence keeps its failed receipt                                  | Later commands receive the old error without reaching their own work, and nothing retries |

The one-shot manager was cheap when presence was a local store. It became a liability once it owned network subscriptions and a release deadline, and the fence turned a bounded network failure into an indefinite outage of one workspace.

## Decision

```text
agent / MCP client
      │  MCP protocol, operation store (stays in the MCP process)
      ▼
MCP process ──session/call-tool──▶ daemon: one workspace replica
                                   ├─ Loro repo, Streams transport, token provider
                                   └─ presence owner (heartbeat writes and liveness reads)
```

- The daemon owns the only workspace replica on a machine. Session and catalog MCP tools, including MCP configuration, archive, cancel and schedules, run there. `session/call-tool` serves both compositions.
- `runWithDaemonWorkspace` lends the daemon's manager to a command the daemon executes. It changes which replica the command uses and nothing else: cloud authorization, workspace resolution and remote recovery stay as they were. The daemon gateway admits a call only while the exact Turn driving the requester Session is active, so a process that outlives its Turn cannot keep using the tools. The local platform additionally keeps its single-user environment and requires that Turn's requester to be the local user; in cloud a collaborator may drive a Session on a shared machine.
- A borrowing command never cleans up the daemon's replica, so command completion has no release step left to fail.
- Roost history stays with each Session's owner machine. The one-shot manager injected owner RPC for every Session, while the daemon's installed Roost owner is its local database. The cloud daemon's manager therefore routes per Session: another machine's Sessions use the same owner RPC services, while its own Sessions, or ones whose owner is not yet known, keep the local owner. The route is separate from `sessionHistoryFactory`, so the daemon's own execution documents keep their auto-read policy. Without it, reading another machine's Session returned empty history and a new input was written to the caller's database, so the owner could not find the dispatched message. This also covers the daemon's cloud Operation recovery, which calls the same create and chat paths.
- MCP cancel and archive call shared in-process helpers instead of spawning a child `lody` CLI, which used to open its own replica.
- A failed release never blocks a workspace. Before admitting a replacement, the presence registry waits for the previous owner's stop to settle, so a new stream never overlaps an unfinished release. If that release failed, the owner is retired: it keeps its retained work in the application root Scope, so shutdown still stops it, and every later acquisition retries it in the background until it releases. Two live owners remain forbidden. `cleanUp` stops presence even when an earlier step fails, so it never leaves a live owner behind. The standalone command pool reports a failed cleanup once (a throwing reporter is ignored) and always removes the entry.

## Alternatives considered

- **Retry the failed release before admitting the next command.** This was the first fix considered. It still blocks while the network keeps failing, so it keeps the outage it was meant to remove.
- **Keep an idle-cached manager in the MCP process.** This would cut the number of cleanups but still keep a second replica, presence owner and token owner per workspace beside the daemon's.
- **A unified data owner for renderer and daemon.** [WorkspaceData services](../../proposed/architecture/2026-10-14-workspace-data-services.md) proposes this larger move. The change here is compatible with it: it removes one duplicate replica without choosing that design's process topology.

## Trade-offs and limits

- Cloud MCP tool work now runs on the daemon event loop, including the operation store's synchronous SQLite calls. OSS has done this since #1133. The MCP process remains the protocol adapter, so it was not moved back.
- Routed calls depend on the daemon. An agent calling Lody MCP already runs inside a daemon-managed Session, so this adds no new availability dependency. Routed calls keep the ten-minute bound the child-CLI path had; only a legacy `wait: true` call gets its maximum wait plus that bound. The earlier OSS bound was 30 seconds. The local-control protocol carries no cancellation, so an abandoned call still finishes in the daemon within that bound; OSS already behaved this way.
- Admitting a replacement while the old owner's work is still retained can let a late write from the old stream arrive. Presence is latest-state with a 90-second TTL and 30-second heartbeats, so a stray entry heals itself; durable data is unaffected.
- Standalone terminal `lody` commands still open a short-lived replica, because no daemon is guaranteed there. Their failures no longer fence later commands. `lody_session_share` stays in the MCP process because it needs the MCP request's abort signal and uses no workspace replica.

## Verification

- `daemon-session-tools.test.ts`, a new owning suite, uses a real `LoroDocumentManager` in the cloud composition. An MCP client call reaches the daemon over a real local-control socket. A collaborator's request executes against the daemon replica. Nested commands borrow that replica and leave it alive. Calls outside the daemon's workspace or machine are rejected.
- In `loro-document-manager-create.test.ts`, the failed-cleanup case now includes a real presence release failure through the native registry. Restoring the previous registry fails with `Workspace presence operation failed`, the reported error.
- `presence.test.ts` checks the native registry: a live duplicate is refused; a stopped owner with a failed release is replaced; a failed background retry is retried again by a later acquisition until the owner releases; and a replacement admitted during an in-flight release waits until the old stream has finished. Restoring the previous registry fails the replacement test too.
- The document-manager test also fails data-plane disposal before presence would stop; removing the `cleanUp` guard leaves a live owner and the next command fails.
- The daemon suite also rejects a call whose Turn is no longer active and a borrowing command whose login no longer matches the daemon.
- `roost-session-backend-contract.test.ts` routes through the real installed local Roost owner: a Session owned by the daemon's machine reads its local history, while one owned by another machine reaches the owner route for both reads and writes. Making the router always use the local owner fails it.
- The command-pool tests show a failed cleanup is reported once, neither a waiting nor a later command is fenced, and a throwing reporter changes neither the accepted result nor later commands. The source-shaped argv test for the removed child-CLI cancel was deleted.
- CLI typecheck, type-aware lint, Effect lint, the platform, process, presence, public, local-writer, inbox and Code Collab boundary checks, and the MCP, session, schedule, zero-cloud and presence suites pass. Packaged-app, live-cloud and live-agent end-to-end runs were not performed.
