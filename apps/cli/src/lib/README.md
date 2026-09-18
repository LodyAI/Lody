# apps/cli/src/lib — file responsibilities

Binding rules live in [AGENTS.md](AGENTS.md) and in the scoped `AGENTS.md` of each
subdirectory; this file is the navigation index. Cross-module explanations live in
[`.agents/docs/`](../../../../.agents/docs/AGENTS.md).

## Message hub and transports

- `usage/usage-tracking-service.ts` — cumulative usage snapshot staging and
  acknowledgement-based retry retention; deltas are never added again.
  Scope and limits: [usage delivery](../../../../specs/usage-delivery.md).

- `message-handler.ts` — the CLI's central message hub (largest file): session chat
  handling (`handleSessionChat`), ACP update buffering/flush, Code Collab v2 machine
  RPC wiring, local project control, session file upload/send, and the turn cloud
  side-effect gate. Turn execution itself lives in
  `../session/session-execution-service.ts`.
- `machine-runtime.ts` — machine runtime bootstrap; still hosts the DEPRECATED hosted
  WS control-plane listener, and serializes remote bridge attach/detach/revoke through
  `runBridgeTransition`.
- `machine-lifecycle.ts` — remote lifecycle verification and upgrade intents; runs the
  fixed npm install through `cross-spawn` so Windows `npm.cmd` shims use the command
  interpreter. `../commands/daemon-runner.ts` owns restart and upgrade handoff.
- `cloud-cli-port.ts` — the sole official-build composition root for cloud clients,
  endpoint-derived adapters, and their lifecycle. `start.ts` validates
  identity/deployment configuration once and injects the resulting `CloudPort` through
  Fleet → Lody → MachineRuntime → MessageHandler/Loro/session services.
- `local-loro-data-plane-server.ts` — Electron renderer ↔ CLI local Loro data plane
  (protocol v7). Design:
  [`.agents/docs/cli-lib-local-loro-data-plane.md`](../../../../.agents/docs/cli-lib-local-loro-data-plane.md).
- `local-ipc-socket-server.ts`, `local-control-handler.ts`, `local-session-control.ts`,
  `local-project-control-service.ts`, `local-project-control-client.ts` — the local
  daemon socket surface and its clients.

## Sessions, files, and attachments

- `session-image-download.ts` — CLI-side prompt image download through the injected
  attachment capability, including short retries before converting bytes to ACP image
  blocks.
- `session-file-blob-store.ts`, `session-file-attachments.ts`,
  `session-file-backfill.ts`, `acp-agent-attachments.ts` — the attachment lifecycle;
  see
  [`.agents/docs/cli-lib-session-files.md`](../../../../.agents/docs/cli-lib-session-files.md).
- `session-gc-manager.ts` — idle cleanup plus memory-pressure reclamation. Per-OS
  measurement rationale:
  [`.agents/docs/cli-lib-memory-pressure.md`](../../../../.agents/docs/cli-lib-memory-pressure.md).
- `session-transient-store.ts` — buffered ACP updates and their turn ownership.
- `session-activity-status.ts`, `session-live-status.ts` — derived busy/idle state.

## Projects and providers

- `local-project-history-sync-service.ts` / `local-project-history-precheck.ts` —
  builtin Codex local-project history import.
- `local-project-removal.ts` — local project deletion, session archiving, and optional
  Lody-created worktree cleanup.
- `provider-setup-manager.ts` — durable builtin provider setup; managed runtimes are installed before verification, while user-installed Bub is only published after a successful live probe.

## Subdirectories

- `acp/` — ACP notification → session history pipeline ([AGENTS.md](acp/AGENTS.md)).
- `code-collab/` — unified Code Collab v2 filesystem RPC service
  ([AGENTS.md](code-collab/AGENTS.md)).
- `file-preview/` — the `file/preview` (File Preview v3) read path
  ([AGENTS.md](file-preview/AGENTS.md)).
- `loro/` — Loro repo/runtime layer, presence, machine flock rooms, and connection
  recovery ([AGENTS.md](loro/AGENTS.md)).
- `pr-poller/` — PR discovery, lifecycle, CI rollup, and merge-state reconciliation
  ([AGENTS.md](pr-poller/AGENTS.md)).
- `review-automation/` — "Auto review and merge"
  ([AGENTS.md](review-automation/AGENTS.md)).
- `analytics/`, `git/`, `notifications/`, `session-export/`, `usage/` — supporting
  services.
