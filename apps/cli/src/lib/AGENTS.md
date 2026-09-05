# apps/cli/src/lib — Index

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

**Before touching message dispatch/sync here, read
context/message-flow.md** — the end-to-end map
(user send → meta-activated dispatch → ACP → Loro Streams → devices). The WS/DO
control-plane path is DEPRECATED; do not add functionality to it.

- `message-handler.ts` — the CLI's central message hub (largest file): session chat
  handling (`handleSessionChat`), ACP update buffering/flush, Code Collab v2 machine
  RPC wiring, local project control. Turn execution itself lives in
  `../session/session-execution-service.ts`.
- Local session control preserves every intermediate response. New clients negotiate
  NDJSON so ACP runtime/auth progress crosses the daemon socket immediately; legacy
  clients keep the buffered JSON envelope. `MachineRuntime` may collect responses for
  completion, but it must also forward each response to the streaming observer as it is sent.
- `cloud-cli-port.ts` is the sole official-build composition root for cloud
  clients, endpoint-derived adapters, and their lifecycle. `start.ts` validates
  identity/deployment configuration once and injects the resulting `CloudPort`
  through Fleet → Lody → MachineRuntime → MessageHandler/Loro/session services.
  Daemon runtime modules must not construct cloud SDK clients or read
  `LODY_AUTH_URL` / `LODY_AUTH_SITE_URL` / `LODY_SERVER_URL`. The local port has
  null optional capabilities and performs no cloud I/O; explicit unavailable
  operations fail at their public boundary, while only contractually
  best-effort background effects may skip. `scripts/check-platform-boundaries.mjs`
  and `tests/local-platform-zero-cloud.test.ts` enforce both halves.
  Client-visible RPC references come from public `@lody/cloud-api`; generated
  server declarations and private workspace packages are forbidden.
  Streams gateway topology comes from the platform token response: prime the
  token provider before reading `getGatewayBaseUrl()`. Runtime transports and
  Machine RPC must not require `LODY_LORO_STREAMS_BASE_URL` as a parallel hidden
  composition path.
- `session-image-download.ts` — CLI-side prompt image download through the
  injected attachment capability, including short retries before converting
  bytes to ACP image blocks.
- `machine-runtime.ts` — machine runtime bootstrap; still hosts the DEPRECATED
  hosted WS control-plane listener. Remote bridge
  attach/detach/revoke are serialized through `runBridgeTransition` (per-runtime
  async queue): bodies never interleave, and attach is deliberately SHORT (no
  meta catch-up wait — dual-author means the CLI only uploads its own ops), so a
  queued detach/revoke stays prompt without preemption machinery. Route any new
  transition through `runBridgeTransition`; keep long waits OUT of transition
  bodies. Backfill enable/disable flips its authorization generation inside the
  queued body (S5: a revoked workspace must never keep backfill enabled).
- **Dual-author (no write intents)**: the renderer direct-authors user/UI
  durable writes against its own repo and uploads them over its own Streams
  connection; the CLI authors only agent-produced data. The former protocol
  v4–v6 write-intent envelope (`WorkspaceWriteIntentAuthor`, `intent`/
  `intent-ack` frames, CLI preview-comment mirror) is REMOVED — do not
  reintroduce any proxy-authoring path (see the invariants in
  `specs/local-first-two-plane.md`). Local dispatch triggers off the renderer-authored
  `latestUserMsgId` doc-meta write (same doc-watch path as cloud dispatch)
  plus the local Machine RPC fast path.
- `loro/AGENTS.md` — the doc-open cost contract: `getOrCreateSessionDoc` joins
  the room and pulls its stream, so bulk/startup/recovery scans must pre-filter
  through room-free indexes and never open docs off a workspace-wide
  enumeration. Read it before touching anything that enumerates rooms.
- `local-loro-data-plane-server.ts` — Electron renderer ↔ CLI **local Loro data
  plane** (protocol v7, push, peer-scoped): dedicated `lody-loro-data-plane`
  socket in the 0700 run dir; routes persistent connections to per-workspace
  `LocalLoroDataPlaneServer` engines (`@lody/shared`, owned by
  `LoroDocumentManager`). Construct `LoroDocumentManager` with its named options
  object; do not restore positional lifecycle dependencies, because adding a
  transport/runtime can silently shift the local data-plane binding. Every
  message carries `workspaceId` + `peerId`
  (per-adapter uuid); the server keys sync state per PEER (`lastSentVV` /
  flock bundle hash), so multiple windows multiplexed over the one relay socket
  sync independently and a sender's own ops are never echoed. Doc rooms sync
  via version-vector deltas both ways; flock rooms via full bundles on change —
  broadcast passes are COALESCED (a queued-pass latch bounds a change burst to
  one running + one queued full `exportJson`, never an unbounded chain; a change
  landing mid-broadcast still gets its own follow-up pass).
  Room topology/import handling is serialized per connection. All workspace
  engines share the process-level `local-loro-data-plane-scheduler` instance
  created in `loro/doc.ts`: presence/CRDT materialization runs via
  `setImmediate`, globally one task/frame quantum per turn. Never run the bulk
  writer inline from a CRDT callback, restore its unbounded loop, or create a
  scheduler per workspace; those variants starve the socket.
  `ping`/`pong` + a 60s idle timeout are the watchdog;
  frame discipline is sender-enforced: an oversized flock delta chunks
  entry-wise, an oversized DOC delta chunks at the transport layer
  (`doc-update-chunk` frames reassembled before one import — a big session
  doc's first catch-up is a realistic oversize, so it must NOT be a terminal
  room error); `payload_too_large` stays terminal only for a single
  flock entry above the budget. Receiver-side skip-until-newline is backup —
  a framing overflow must NOT destroy the socket. Feed `createJsonLineSplitter`
  the RAW socket chunk: it owns a stateful UTF-8 decode, and per-chunk
  `toString('utf8')` mangles a multi-byte character split across a chunk
  boundary into U+FFFD. A flock bundle carries file paths as literal UTF-8 JSON,
  so that corruption becomes a permanent garbled LWW key in the receiver's
  replica (`isCorruptedCodeCollabWorkspacePath` prunes the survivors).
  Named Flock docs opened by a renderer are bridged by `LoroDocumentManager`
  into `repo.joinFlockDocRoom()` and
  released on the last local peer leave; Code Collab `fi`/`fis` and machine flock
  docs must not rely on `syncOnce()` as live cloud subscription. These cloud
  hydrates are background data relays ONLY. A renderer-joined Session Doc uses a
  separate four-way bounded, one-shot raw `joinDocRoom` reconciliation: never create a
  `SessionDocument`, release after first remote sync or local leave, and unload the repo
  doc after the last local peer leaves unless dispatch has activated the Session. This
  preserves CLI-authored offline backfill without retaining every historical cloud room.
  Raw join/leave and `SessionDocument` activation are serialized per doc id: activation
  must wait for an already-started `repo.unloadDoc`, then open a fresh doc, so an in-flight
  renderer-only release cannot evict the handle retained by dispatch.
  For both room kinds,
  the CLI's cloud room status is never pushed to renderers as local room
  health — offline cloud failures must not poison the renderer's local
  reconnect loop (`specs/local-first-two-plane.md`). There is NO polling
  and no request/response HTTP path. Electron side:
  `apps/electron/src/main/services/loro-data-plane-relay.ts` (persistent socket
  with redial backoff + ping watchdog, `webContents.send` broadcast fan-out +
  status channel; synthesizes peer `detach` for destroyed/navigated windows).
  Renderer adapter (`@lody/shared` `local-loro-transport.ts`) filters inbound
  by workspaceId+peerId and treats every (re)join as the reconciliation point:
  it up-syncs its delta from the returned `serverVersion` regardless of the
  in-memory dirty flag (offline writes survive app restarts and dropped
  frames). Regression suite: `packages/shared/tests/local-loro-transport-bug-repro.test.ts`.
- Liveness lives on the ephemeral presence channel (`loro/presence.ts`): machine presence
  refreshes on `CliPresenceRuntime`'s own 30s timer. That runtime keeps TWO stores and the
  distinction is load-bearing: `store` is the workspace-wide replica (own writes + every
  peer observed in the shared presence room, read by machine-online checks and the PR
  poller), while `localOriginStore` holds ONLY entries this process authored and is the
  sole payload of the local data plane (`encodeLocalOriginPresence` /
  `subscribeLocalOriginPresence`). Write locally-authored presence exclusively through
  `writeLocalOrigin`/`deleteLocalOrigin` so the two can never diverge, and never relay the
  replica — `specs/local-first-two-plane.md` explains why presence plane ownership is
  partitioned by origin.
  Session active presence is owned by `loro/session-active-presence.ts` only:
  it starts once for a visible CLI turn,
  accepts phase updates from other code, heartbeats while active, and clears on the
  owning Effect release. That scope covers ALL turn-finalization stages, so
  optional cloud side effects inside it (usage flush, completion notification, Live
  Activity sync) MUST go through `MessageHandler.runTurnCloudSideEffect`:
  known-offline (streams transport down) skips immediately, otherwise a 10s
  bounded wait backstops half-open networks — never an unbounded hosted API await
  (the cloud-sync-state signal in `specs/local-first-two-plane.md`). Third-party calls (GitHub,
  model APIs) are a different reachability domain and are NOT gated by it. Do not publish/clear session presence from `setStatus`, RPC
  dispatch, permission/image callbacks, or watcher recovery paths. Do not reintroduce
  periodic doc-meta writes (`lastSeen`/`lastRunningSeen`) — they stall Loro flush; meta
  timestamps are written only at status transitions, and Web live working UI reads
  session presence directly instead of overlaying it onto `SessionMeta.status`.
  Durable `MachineMeta.lastSeen` is fully retired (not written even at registration);
  machine online checks read presence only. One-shot commands can read a presence
  snapshot via `LoroDocumentManager.getOnlineMachineIds()` (null = presence room not
  joined → status unknown, not offline).
- Device resources use the separate `loro/machine-monitor.ts` ephemeral channel.
  Local renderer observer/snapshot state crosses protocol-v6 `machine-monitor`
  frames and MUST sample without a cloud transport. Cloud observers/snapshots attach
  only after the authorized remote bridge attaches and detach on offline/revocation.
  Sampling is observer-lease driven; never start OS probes permanently or persist snapshots.
- Machine Flock writes for this CLI's own machine must be local-first: after `repo.flush()`,
  call `LoroDocumentManager.markMachineFlockDocDirty(...)` (or pass the manager as the
  sync scheduler) instead of awaiting `handle.syncOnce()` in the user/RPC request path.
  `loro/machine-flock-sync-coordinator.ts` owns the live room, dirty state, and
  exponential retry; request-scoped `syncOnce()` failures must not make local project
  add/update flows fail after the local write is durable.
- Builtin Codex local-project history import is read-only: require
  `_meta.lody.sessionHistory` v1 and call the Core-defined history method; never fall back to
  `loadSession`, which resumes the thread and can contend with its active writer. Publish a new
  imported Session only after history and its cursor are durable; legacy `metadata_only` shells
  remain selectable so the next import can finish hydration.
- `loro/machine-flock-command-watcher.ts` owns the machine's durable COMMAND
  subscription (archive/delete/delete-local-project/provider-setup), separately from the
  sync coordinator's write room. Flock rows are durable, so reconnect correctness is
  SCAN-based, not event-based: every authoritative join rescans every queue, and join or
  initial-sync failures retry with bounded backoff. Events are only low-latency wakeups
  and carry `authoritative`, which gates provider setup — a stale local setup row must
  not outrun a remote cancellation. Route both the event and rejoin paths through
  `MessageHandler.rescanMachineCommands`: a command family wired to only one of them
  fails silently, because its queue simply stops draining. Room-status recovery uses the
  shared `isRecoverableStreamsRoomStatus` ('detached' is never recoverable).
  Removing a local project archives every unarchived Session that references that
  machine/project before deleting the project row. Discover those Sessions through the
  existence and metadata indexes; never open every Session document to find them. A failed
  archive keeps the delete command queued so a later scan can retry it. Optional worktree
  cleanup is limited to Lody-created Session worktrees for that project: inspect every
  worktree before submission and again immediately before deletion, never force-delete or
  backup-commit a dirty worktree, and record per-worktree deleted/kept/failed results. The
  original project directory and its files are never deletion targets. Cleanup failures must
  complete the project command with a visible result instead of leaving removal pending.
- **Streams recovery has TWO signals and they must not be recombined**
  (`loro/connection-recovery.ts`). `onStreamsOnline` is cheap, unthrottled, and
  fires on every health rising edge — it RELEASES work parked while offline
  (dirty Machine Flock docs, which arm no timer of their own, plus the
  task/review automation queues). `onMetaRoomSynced` is the EXPENSIVE
  "rescan the workspace index" signal whose listeners do O(rooms) work, so it
  waits for meta catch-up and is rate-limited to one fan-out per
  `LODY_LORO_META_SYNCED_MIN_INTERVAL_MS` (30s) — deferred, never dropped,
  because the dispatch bootstrap scan is the only retry path for a session whose
  reconcile threw. A fan-out that follows a real meta-room outage skips the
  floor; a transport-only flap does not. One signal carrying both meanings is
  what turned a single stuck room into ~3400 session reconciles/minute.
  Backoff is flap-aware for the same reason: health that does not survive
  `LODY_LORO_HEALTH_STABILITY_WINDOW_MS` (5s) counts as a failed recovery and
  charges the attempt counter instead of resetting it, and `force` must not
  clear that history. Regression coverage: `tests/reconnect-storm-repro.test.ts`.
- `session-gc-manager.ts` — idle cleanup plus memory-pressure reclamation. `evaluateMemoryPressure`
  returns TWO independent verdicts, `evict` and `block`, and they are not the same threshold:
  reclaiming an idle session is invisible (it is restored on its next turn), refusing a turn is a
  user-visible failure. On **macOS the signal is `kern.memorystatus_vm_pressure_level`**, not bytes
  — WARNING reclaims, only CRITICAL refuses, and an unreadable level FAILS OPEN. Do not add a
  byte-threshold fallback there: byte estimates cannot see compressor headroom, which is where a
  Mac's reclaimable memory lives, so they report pressure on healthy machines.
  On **Linux under a cgroup, `memory.max - memory.current` is NOT headroom** — `memory.current`
  counts page cache, so a tree scan parks tens of GB of clean cache in it and the cgroup reads as
  full while resident memory is a fraction of that. Headroom therefore credits reclaimable
  cache/slab (`computeCgroupReclaimableBytes`), and because that estimate deliberately excludes
  `active_file` it is only allowed to RECLAIM on its own — refusing a turn additionally requires a
  real stall (`memory.pressure` some avg10, or a hard-headroom floor on kernels without PSI). Host
  `MemAvailable` needs no such corroboration; it is already reclaim-aware.
  On **Windows the commit limit is NOT a hard ceiling** — with the default system-managed page
  file it is `RAM + current page file size`, and Microsoft documents that Windows grows the page
  file once commit charge hits 90% of the limit, so a healthy machine sits permanently a few
  hundred MB under its CURRENT limit. `utils/memory.ts` therefore measures the page file
  configuration too (`computeWindowsCommitGrowthBytes`, pure/testable) and refuses only on
  `effectiveAvailableCommitBytes = availableCommit + growth`; raw commit headroom and low
  `AvailableBytes` may only RECLAIM. The documented system-managed ceiling is
  `min(max(3 x RAM, 4GB), volume size / 8)` and **the volume/8 term is load-bearing** — it binds on
  small disks, i.e. exactly the machines that do run out of commit. Growth is `number | null`:
  `null` means UNDETERMINED (unreported volume, or an empty page file enumeration on a machine
  whose commit limit exceeds RAM) and drops `effectiveAvailableCommitBytes` so the check fails
  open. Never collapse `null` to `0` — that manufactures a hard ceiling out of a failed probe.
  Physical availability never refuses on Windows at all: the Memory Manager trims working sets and
  pages out rather than failing, which is why Chromium/.NET/SQL Server all treat physical pressure
  as a shed-caches signal only. `os.freemem()` is the physical number (libuv returns
  `ullAvailPhys`, i.e. free + zero + standby) — do not add a probe for it.
  Commit comes from `powershell.exe`, preferring the documented `\Memory\Commit Limit` /
  `\Memory\Committed Bytes` perf counters and falling back to `Win32_OperatingSystem`
  (`TotalVirtualMemorySize`/`FreeVirtualMemory` are `ullTotalPageFile`/`ullAvailPageFile` in
  practice, but the CIM docs do not say so — hence fallback, not primary). Timeout is 5s because a
  1s budget expired exactly on the loaded machines it exists to measure, and a failed probe fails
  OPEN as on macOS. That probe is a PROCESS SPAWN, so it is cached for 30s and the sampler only
  bypasses the cache via `refresh()`/`getMemoryPressureSnapshot({ force: true })` — the paths about
  to act. Do not make the periodic sweep force it: at the monitor's 5s cadence that is ~17k
  `powershell.exe` launches a day on an idle daemon.
  Two more rules, both learned from a false refusal: never act on the CACHED sample (force a
  refresh once anything looks like pressure), and re-check with a short delay before failing a turn
  (`pressureRecheckAttempts`) because reclaim returns cache in milliseconds. Eviction is bounded
  per call (`maxEvictionsPerCall`) because the caller awaits it on the prompt hot path. The
  threshold is a safety MARGIN, never "what a turn needs" — do not phrase it that way to users.
- `provider-setup-manager.ts` owns durable default managed-builtin creation;
  setup rows with executable runtime overrides are invalid. The future
  config stays under `['providerSetup', configId]` while runtime/auth/live-probe
  work is incomplete; only the target CLI may publish it by writing `agentConfig`
  and deleting `providerSetup` in one commit. In cloud/dual mode queue processing
  starts only after the machine Flock's first remote sync, so a stale local row
  cannot outrun a remote cancellation. The OSS local platform has no remote
  transport; its opened SQLite-backed Flock is authoritative, so existing rows
  are processed immediately and new local-data-plane rows trigger the same queue.
  Never make local mode wait on `firstSyncedWithRemote`. Cancellation remains as
  `['providerSetupCancellation', configId]`; after merges, the owning CLI causally
  deletes any concurrently published setup/config. Restart resumes only
  non-interactive states. Never add
  authorization URLs, codes, tokens, or raw provider output to a setup row, and
  never publish from caller-supplied auth RPC fields.
- `acp/` — ACP notification → session history pipeline (`history.ts`:
  `handleACPUpdateMessage`, per-toolCallId enrichment, edit-evidence extraction;
  `history-apply.ts`: CRDT history writes). Protocol: `context/acp-protocol.md`;
  per-agent payload quirks: `context/acp-agent-edit-evidence.md`.
  ACP updates must be bound to assistant-entry ownership at enqueue time, not by
  asking for "the current turn" during flush. `session-transient-store.ts` stores
  `assistantEntryId`/`userTurnId`/`turnEpoch` on each buffered update; `acp/history.ts`
  exposes explicit assistant-entry vs autonomous append APIs and must not silently
  create uuid entries for unowned output. This prevents bad-network/retry tails and
  duplicate dispatch from rendering the same agent turn twice. Flush retries retain
  notification-level progress and cached rich-content materialization (never re-upload
  an attachment after only its history write failed), stop automatic retries after a
  bounded backoff budget, and carry the enqueue-time turn id into Code Collab evidence.
  Evidence arriving for a finalized target is serialized through the same per-turn
  persistence chain as normal finalization; a failed persistence attempt restores both
  captured evidence sets ahead of concurrently collected evidence and schedules bounded,
  evidence-only backoff retries that never replay the already-persisted ACP history update.
  Shutdown cancels those timers, waits for active per-turn chains, and directly drains retained
  evidence before closing the diff store. It must first stop SessionManager producers while
  keeping workspace documents open, then wait for already-started async evidence collectors,
  flush ACP/evidence, and close stores; never close a store or take the final map/chain snapshot
  while agent callbacks or tracked evidence collectors can still populate turn evidence.
  Permanent deletion blocks new ACP enqueue, waits for an already-started flush, and
  drops retry state before deleting the session doc, so a late retry cannot recreate
  deleted data.
  The finalized-turn late-ACP routing target does NOT expire by wall-clock time
  (`session-transient-store.ts`): agent sessions stay alive and emit events long after
  `stopReason` (cron, `ScheduleWakeup`, deferred work), and those must still reach the
  Loro doc. The target is cleared only when a new turn owns ACP updates (normally
  `beginTurn()`, but visible dispatch defers until prompt start) or replay suppression.
  This is what lets the web derive the "session will continue" panel from the Cron/ScheduleWakeup
  `tool_call` items in history — the CLI persists NO extra scheduled-task state (not in
  `SessionMeta`, not a new history item); see `@lody/shared`
  `collectPendingScheduledTasksFromHistory` + `nextCronFireMs`.
  INVARIANT: `history-apply.ts` strips `rawInput`/`rawOutput` from ALL generic tool calls
  (unstructured by spec) EXCEPT the four scheduling tools in `SCHEDULING_TOOL_NAMES`
  (`CronCreate/CronDelete/CronList/ScheduleWakeup`, matched via `_meta.lody.toolName`),
  whose small `rawInput`/`rawOutput` are kept, whose persisted `title` is pinned to the
  canonical tool name, and which also record `schedulingTimeZone` (this machine's IANA zone,
  captured at persist time — cron is local-time to it, so the panel resolves fire times in
  that zone via `nextCronFireMs`, not the viewer's browser zone) and `recordedAtMs` (the
  first-persisted wall-clock sighting; the turn entry's `endedAt` is NOT a safe creation
  anchor because runtime-internal cron-fire steers keep extending the same entry past a
  one-shot's fire minute, which rolled the resolved fire to the next year — the "fires in
  364 days" phantom). For one-shot crons the deriver prefers the output's `nextFireAt`
  line over any anchor. The deriver reads exactly
  those fields — do not "clean up" this exception or the panel goes silently empty (unit tests
  fabricate history and won't catch it).
  The former `_meta.claudeCode.toolName` carrier is read only by the centralized
  one-release compatibility path; new provider output must use the Core contract.
  RPC fast-path ordering: turn-scoped history LIST writes in `message-handler.ts`
  (assistant entry creation, ACP/proposed-plan flushes, finalization, chat_failed
  notices, image-group entries) first `await awaitTurnHistoryGate(sessionId)` —
  see `../session/turn-history-gate.ts`. Add the same await to any NEW code path
  that appends/positions history entries during a turn; map-keyed status/meta
  writes stay ungated.
- `task-doc.ts` — every CLI-side read/write of a Task document (`readTask`,
  `createTaskFromAgent`, agent property/PR updates, exact-match body edits, comments,
  session links) plus `listWorkspaceTaskIds` and the index-only listing
  (`listTasksFromIndex` / pure `selectTaskIndexRows`). Creation is the ONE path that
  passes `initialState` to the Mirror (`seedEmptyDocument`): every other path must see
  an absent document as absent, or `readTask` starts answering with a placeholder meta
  and TASK_NOT_FOUND stops existing. Three invariants: **each write republishes the
  index row**
  from the document's post-write state (the index carries what lists render —
  counts, `lastCommentAt`, mentioned users — so skipping it makes the change
  invisible), persisted Task documents have a repo `e/task-<id>` existence
  entry but no duplicated `m/*` business meta, and **the agent field is never written
  here** — it is the automation consent, so `applyAgentTaskUpdate` covers every other
  scalar but must not grow an `agent` branch. Anything needing every visible Task
  uses `listWorkspaceTaskIds`: it merges existence with index rows, repairs a
  missing projection from the Task document, and never revives an index tombstone.
  Note that `status`/`ownerId`/`projects` writes here can make a task automation-
  eligible and start a session (see `task-automation/`).
  Normative contract: specs/tasks.md.
- `task-image-upload.ts` — MCP `lody_task_upload_images` reads local images with
  `O_NOFOLLOW`, uploads them to the current workspace's private Task image
  endpoint, and returns stable `lody-image://<imageId>` Markdown references.
  It does not append anything to Session history; agents explicitly pass the
  returned Markdown to Task propose/body/comment tools.
- `task-automation/` — delegated automation: `planTaskAutomation` is a pure policy
  (all the gates that keep it from spending tokens by surprise), the scheduler is a
  thin orchestrator, and the per-workspace handle watches the task index and
  re-evaluates on `onMetaRoomSynced` so work held while offline still starts. An
  agent counts as busy while its task is **in progress**, not merely while being
  dispatched — otherwise one agent gets two concurrent sessions in one working copy.
- `review-automation/` — "Auto review and merge": a review agent reviews a
  branch, blocking findings go back to the authoring session, and the PR is
  merged once CI is green. Lives here rather than in MCP because the chain-depth
  guard caps a chain at 5 hops and CI/GitHub are outside the MCP contract, which
  is exactly why its own budgets are load-bearing. Auto-merge deliberately does
  NOT reuse `deriveSessionPullRequestReadiness` (an absent CI rollup counts as
  ready there, which would merge before CI runs). Invariants:
  [AGENTS.md](review-automation/AGENTS.md).
- `code-collab/` — unified Code Collab v2 filesystem RPC service; see its own
  [AGENTS.md](code-collab/AGENTS.md).
- `file-preview/` — the `file/preview` (File Preview v3) read path: text AND binary,
  size-limited, path-allowlisted for remote transport. Electron's local-only
  `file/preview-local` IPC counterpart is deliberately the exception: it allows the
  desktop user to inspect any local regular file, read-only. **A preview must never
  activate Code Collab** — no workspace watch, no All Changes recompute, no Flock
  publish. That coupling is exactly what this directory was split out to remove; see
  its own [AGENTS.md](file-preview/AGENTS.md).
- **Session file attachments** (spec: `specs/session-files.md`): `message-handler.ts`
  has `handleSessionFileUpload` (cloud, MCP `lody_upload_files`) and local
  `handleSessionFileSendLocal`. Local bytes live in `session-file-blob-store.ts`
  (`~/.lody/session-files/<ws>/<sess>/<fileId>`) as `transport:'local'`.
  At dispatch, `materializeSessionFileAttachments` copies/downloads to
  `<workspace>/.lody/attachments/...` and sends ACP `resource_link` blocks with
  `file://` URIs; do not degrade this to text-only paths. Backfill
  (`session-file-backfill.ts`) uploads local blobs through the injected relay,
  flips persisted blocks
  `local→r2`, rewrites `fileId` to the relay key, and is triggered by dispatch,
  opportunistic handoff, and startup recovery. The flip rewrites the fileId, so a
  `.r2meta` sidecar (relayFileId) is written BEFORE the flip: restart recovery uses
  it to finalize a flip-committed-but-unmarked blob instead of retrying "not yet
  persisted" forever. A blob with no history block older than the draft retention
  window is reclaimed (abandoned staged-but-never-sent draft); blob-store writes
  are serialized process-wide for the quota check. Backfill commits (marker
  write, history flip) are gated by an authorization generation +
  AbortController owned by `MessageHandler`: `disableRemoteBackfill`
  (offline/revoke) aborts the in-flight relay upload and supersedes started
  tasks, so a revoke landing mid-upload can never adopt the uploaded bytes
  (S5/D10: revocation must prevent upload); re-enable opens a new generation and the pending blob
  backfills on the next scan.
  Human image inputs keep their ACP `image` block for visual context and also
  materialize the same bytes to `.lody/attachments` as an ACP `resource_link`, so
  agents can echo/transform them through a local file path.
  Agent→human ACP `image` / `resource` / `resource_link` output is materialized by
  `acp-agent-attachments.ts` during `message-handler.ts` ACP flush: upload to the
  injected image/file capability, then append `image_group` / `file` history blocks.
  `resource_link file://...` is accepted only when contained in the session workspace.
- `replay-prompt-builder` (in `@lody/shared`) + `message-handler.ts` resume fallback:
  see `context/hotspots.md` "CLI: prompt + message handling".
