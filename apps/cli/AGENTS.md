# CLI Agent Guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` applies; this file adds CLI context.

## Running the CLI in development

`pnpm dev` bundles with esbuild (`scripts/dev-build.mjs`, ~3s) into `dist-dev/`, then
runs `node --enable-source-maps dist-dev/index.js`. `pnpm dev:build` builds only;
there is no on-demand TypeScript-loader fallback, so development startup must
run built JavaScript.
The public CLI defaults to local platform, does not discover deployment dotenv
files, and must never initialize telemetry in local mode even if generic PostHog
variables are present in the shell.

INVARIANT: the dev output layout must match production's — `index.js` plus flat sibling
`claude-acp.js` / `codex-acp.js` / `*-worker.js`. `agent/setting.ts`, the Tinypool pools
(`file-index-scan-pool.ts`, `diff-line-count-pool.ts`), the direct
`turn-diff-store-worker.ts` client, and `workspace-watch-coordinator.ts` all locate
their child by FILENAME next to
`import.meta.url`. Running directly from `src/` would leave only `.ts` siblings, so pools
would fall back to the main thread (`reason=worker_missing`) and mandatory workers would
be unavailable. `dev-build.mjs` asserts after each build that no
worker-resolving module was hoisted into `chunks/`, because that reintroduces the same
invisible fallback.

Two things the dev build does deliberately, both load-bearing:

- npm packages stay external (that is what makes it fast, and it avoids inlining wasm),
  but they are externalized by ABSOLUTE path — bundling a workspace package's `.ts`
  source moves its imports into this bundle, and pnpm's strict layout has no entry for
  that package's transitive deps under `apps/cli/node_modules`.
- `splitting: true`, so `await import(...)` stays a real lazy boundary. `review-viewer.ts`
  statically imports the generated `lody-code-review-viewer/manifest`, which does not
  exist until that package is built; inlining it would make `lody --version` fail.

## Coding rules

- The CLI's own `version` must be imported from `@/pkg`, never from a relative
  `../package.json`. Each build composition aliases `@/pkg` to the manifest that
  actually gets published (cloud builds point it at the private composing
  package), so a relative import bakes the stale OSS version into the published
  bundle — this is what made `lody@0.82.1 --version` print `0.76.0`. The package
  `name` is the exception: it stays `lody` in every composition.
- context/cli-effect-ts.md — prefer Effect TS idioms
  for new/refactored CLI code: services via `Context.Tag` + `Layer`, typed errors,
  structured concurrency, `Schedule` retries; when raw async/await is OK; interop.
- context/cli-type-safety.md — strict tsconfig
  (`noUncheckedIndexedAccess` etc.), no `any`/non-null assertions, Zod for all foreign
  data (JSON.parse, WS payloads, env), dependency type alignment.
- context/cli-prompt-hot-path.md — after the
  CLI receives a remote prompt, only correctness-critical setup may block before ACP
  `agent.prompt`; notifications/analytics/UI summaries must not be awaited there.
- context/cli-startup.md — local-ready boundary,
  remote reconcile sequence, and startup timing trace names.

## Debugging

- Local logs (`~/.lody/logs/`, levels, `lody daemon logs`, ACP stderr capture):
  context/cli-logs.md.
- Preview targets are untrusted. Keep automatic candidates loopback-only and
  require explicit recent user approval before accepting a private literal IP;
  validate path-relative targets at the CLI boundary.
- The local preview proxy must never forward an OBSERVED WebSocket close code into a
  Close frame. RFC 6455 reserves 1005/1006 for local observation, so `ws` throws from a
  TCP callback and kills the CLI with the active Agent session. Mirror the shape instead
  (`mirrorWebSocketClose` in `preview/local-preview-proxy.ts`): `terminate()` for 1006,
  code-less `close()` for 1005. Both directions, plus the local-socket `error` handler,
  which must not pre-empt that mirror once the connection is open.
- Embedded CLI packaging invariants (native deps, ABI, child runtime env) live in
  [apps/electron/AGENTS.md](../electron/AGENTS.md). Read them before changing runtime
  deps/bundle externals or spawning `process.execPath` with a filtered environment.
- `engines.node` is pinned to `>=22.14.0` by better-sqlite3's `NAPI_VERSION=10`, and
  `src/utils/sqlite-runtime-support.ts` must stay the FIRST import in `src/index.ts`. Older Node
  segfaults on the SQLite binding instead of throwing. Rationale + the three places that
  must move together: [apps/electron/AGENTS.md](../electron/AGENTS.md) (native deps).

## Process lifecycle

- Read context/local-agent-ownership.md
  before changing local ports/sockets, daemon PID state, Electron/daemon startup,
  Supervisor retries, or Worker shutdown. Health probes are observation only and
  must never authorize PID killing.
- Cloud-mode `lody daemon status` reads the runtime probe's explicit `backend` authorization/
  connection state and `connectedWorkspaces`; local mode omits that cloud-only block. Aggregate
  `connectivity` is local runtime health and must not be presented as proof that the cached CLI
  token was accepted.
  Connection-age fields preserve one continuous non-connected interval across
  connecting/disconnected transitions and clear only on connected. They travel in the
  top-level `connectionAges` v1 extension because older consumers reject unknown keys inside
  the strict backend/workspace objects but accept unknown top-level state. Status colors
  these states and reports a red connection error once that interval reaches 60 seconds.

- `lody daemon start` resolves cloud authentication in the FOREGROUND process before
  spawning the detached runner (`commands/daemon-auth-preflight.ts`): validate the cached
  credential against the backend, and on a missing/rejected credential run the interactive
  device-authorization flow (browser link) right there. The runner is detached, so a
  credential failure inside it is invisible. An unreachable backend aborts instead of
  re-authenticating — a network outage must not replace a working credential — and a
  non-TTY run aborts instead of blocking on a browser link until the device code expires.
  `--skip-auth-check` is the explicit opt-out; `--auth` keeps its non-interactive path.
  The runner's fd 3 launch handshake reports success only after its supervised Worker reaches
  `startupStage=ready`; an initial Worker exit returns its bounded output to the foreground and
  terminates the runner instead of claiming that daemon startup succeeded. Explicitly retryable
  startup exits keep that handshake pending, and a handshake timeout terminates and awaits the
  exact spawned runner before the foreground reports failure.
- New one-shot commands should use `src/lib/command-runtime.ts` (`runOneShotCommand`)
  so exit codes, telemetry flush, and stream flushing are handled consistently.
- Process entrypoints, command-owned boundaries, global process-error handlers, and
  generated standalone shims may force exit after their own cleanup policy: `start.ts`
  owns startup/fatal/signal exits; `daemon-runner.ts` owns watchdog fatal and signal
  exits. This is process-boundary policy.
- Never force exit from reusable business libraries, session/agent internals, TUI/watch
  flows, or worker code. Those modules should expose explicit cleanup and let the
  process boundary decide whether to exit.
- Remote daemon restart/upgrade is documented in
  context/machine-lifecycle.md. The RPC handler
  ACKs and asks `start.ts` to exit with the reserved lifecycle code; the watchdog
  performs upgrade/restart work after the worker exits.
- Session read commands (`session list/show/history/status` and `export`) sync Loro
  metadata/docs before reading by default; sync failure is a command failure with an
  `--offline` hint. `--offline` is the explicit local-cache path, not an automatic
  fallback. `lody sync` is the explicit workspace sync command and excludes Code
  Collab file-index Flock docs.
- Persisting a non-empty Task document makes loro-repo register
  `e/task-<id>` in workspace meta; Task business fields are not copied into
  `m/task-<id>/*`. `listAliveRoomIds` enumerates `e/*`. `listWorkspaceTaskIds`
  combines that physical existence source with visible Task Index rows, repairs a
  missing row from its Task document, and honors an explicit index tombstone.
  `sync`, `export`, and account deletion must retain both discovery paths so an
  interrupted or legacy write cannot silently escape coverage.

## `lody app` (open the desktop app on a directory)

- `src/commands/app.ts` registers the directory as a local project through the
  daemon (`local-project/add`, idempotent — the id is a sha256 of the resolved root
  path), then hands the active installation profile's deep link
  (`lody://chat/new?…` for cloud, `lody-oss://chat/new?…` for local) to the OS
  via `utils/open-browser.ts`. Link shape lives in `src/lib/desktop-deep-link.ts`;
  the desktop side parses it in
  `packages/components/src/lib/desktop-open-local-project-deep-link.ts` and routes to
  `/<slug>/chat?context=local&machine=…&project=…`. Both sides pin the URL in unit tests.
- INVARIANT: registration happens only in the CLI. The deep link carries ids, never a
  path, and the app must never register a project from one — any web page can navigate
  the OS to either registered protocol, so a path-carrying link would let a site hand agents an
  arbitrary directory. An unknown project id just stays unselected.
- `workspaceSlug` is present only when the daemon reported workspace candidates (i.e.
  multiple active workspaces). With one workspace the app's current workspace is
  already correct, so the link omits it.
- Daemon down is not a failure: the deterministic project id is computed locally and
  the app still opens (already-registered directories stay selectable); the command
  warns that a brand-new directory was not registered.
- Local-project control transport, workspace-candidate parsing, and the workspace
  picker are shared with `lody project` in `src/lib/local-project-control-client.ts`.

## `lody review` (no-login HTML review)

- `src/commands/review.ts` renders a `.review.md` (or `.review.json[.gz]` snapshot)
  into a self-contained HTML file and opens it; `lody review prompt` prints the agent
  prompt; bare `lody review` prints a 3-step guide. No Lody login is involved.
  Reading `.review.md` resolves against the local Git repo read-only. On render
  failure the action prints `error.message` and sets `process.exitCode = 1`.
- The ~8 MB viewer is NOT bundled. `src/lib/review-viewer.ts` fetches the public
  `lody-code-review-viewer` package's `standalone.html` from jsDelivr (then unpkg)
  at the EXACT version the CLI was built against, verifies its sha256, and caches it
  under `~/.lody/code-review-viewer/<version>.html`. `LODY_REVIEW_VIEWER` (file path
  or URL) overrides the source for offline/mirror use (still sha-verified). The
  pinned version + sha come from the bundled-at-build `lody-code-review-viewer/manifest`
  import (the only viewer piece kept in the CLI bundle; ~3 KB); CLI `build:bundle`
  prepares that viewer package first. The external release pipeline must publish
  the viewer at the same version before the CLI. See `packages/code-review-viewer`.
- The agent prompt IS still embedded (small) via `@lody/code-review-helper/prompt-text`
  (generated by the helper's prompt embed script before bundling), lazy-imported in the action.

## Session create/worktree shortcut

- `lody session create --local-project ... --worktree` is wired by setting
  `ProjectRef.useWorktree` in `src/commands/session.ts`; daemon startup consumes
  that flag in `src/session/session-execution-service.ts`, and actual local/GitHub
  worktree creation happens in `src/session/session-manager.ts`.
- Post-turn automatic commit/push is allowed for GitHub worktrees and local projects
  with `ProjectRef.useWorktree === true`. Never run it against a local project's
  original directory, even when that project has a `githubRepoFullName` or associated PR.
- Local create resolves `ProjectRef.githubRepoFullName` from the project's `origin`
  for direct AND worktree sessions, exactly like desktop creation, because
  `repoFullName`, PR actions, and post-turn PR detection all read it. Bind only a
  repository the workspace enables, recording the workspace's spelling; an
  unauthorized, absent, or unreadable one leaves the Session local rather than
  failing create.
- MCP session tools use stable machine/session/agent-config ids and strict, narrow input
  schemas. New create/chat Commands require a caller-chosen Operation id. Create persists
  the Operation before its fallible availability/materialization step; the normal response
  has durable target input, while a transient post-accept failure returns the active fixed
  target for daemon replay. `session_create({ operationId, resume: true })` recovers that
  Operation without resending the prompt. Completion is delivered automatically, with no
  public wait tool.
  Legacy single create/chat `wait=true` remains a temporary compatibility adapter;
  new callers must not depend on it. Child Sessions are one level deep only.
  An independent Session created from inside another Session persists exact provenance in
  `openedBySessionId`. If that opener is a child Tab, it also sparsely persists the Tab owner's
  root route as `openedByRootSessionId`; clients need both ids to restore the exact originating
  Tab. Do not rewrite the exact opener to the root or treat either pointer as `parentSessionId`.
- Local daemon IPC sends the real control request once; do not restore a health preflight.
  Native `LocalDaemonAvailabilityError` must be thrown outside the Effect runtime boundary
  so MCP can preserve `DAEMON_NOT_RUNNING` versus retryable `DAEMON_BUSY`. A connection
  refusal means not running; timeout/408/429/5xx means busy.
- The task MCP replies are bounded the same way: a task body is capped at 64 KiB with
  head-and-tail truncation (`bodyTruncated` + `bodyOmittedBytes` state it), comments
  return the newest 20 with `commentCount` when more exist, links cap at 50, and
  `lody_task_list` defaults to 20 (maximum 100) reporting `matched` when the page was
  cut. The document itself has no body limit, so an unbounded read would blow the
  caller's context. Keep both ends: `lody_task_edit_body` matches exactly against the
  FULL body server-side, so an agent editing from a truncated view still resolves.
- `lody_task_list` reads the Task Index Flock ONLY (`listTasksFromIndex` →
  `selectTaskIndexRows`). Never make a list path open task documents: that is the whole
  reason the index exists. `order` is deliberately not returned — it is a fractional
  index and callers must not depend on its format.
- `lody_task_update` writes every scalar property EXCEPT `agent`, and never the body.
  Two different reasons, both load-bearing: the body goes through the exact-match edit
  so a content change carries its size delta and origin, while `agent` is the sole
  automation consent — an agent writing it would hand itself a scheduler slot. Do not
  "complete" the surface by adding it.
- INVARIANT: `status`, `ownerId`, and `projects` are all in the delegated-automation
  eligibility predicate (`planTaskAutomation`), so an agent write to any of them can
  START a session on an already-entrusted task. Keep it in mind before adding another
  agent-writable field: anything in that predicate is an execution trigger, not just a
  property. Each write records an attributed activity entry on the task document —
  but note that entry is an audit record, NOT a user-visible notice: `task-thread.tsx`
  deliberately renders only `pr_linked`, because property-edit entries were shown once
  and were unreadable (raw ids) while the properties rail already shows current values.
  So do not cite the timeline as the thing that tells a person their task changed.
- `ownerId` on an agent WRITE accepts ONLY `""` (unassign) — `TaskOwnerIdWriteSchema`.
  Naming an owner points `isTaskAutomationEligible` somewhere new: it runs a task only
  when the owner is the local operator, so an agent that could set that field could
  route a task referencing this operator's agent config into execution under this
  operator's credentials, on a consent belonging to whoever set `agent`. Unassigning
  only ever REDUCES eligibility, so it stays open. This also disposes of the `me`
  sentinel that `lody_task_list` accepts as a filter — stored verbatim it would name no
  user, silently removing the task from every owner view with an `ok` reply.
  **The restriction lives at the MCP boundary, not in `task-doc.ts`**: the document
  layer is also the human write path (the app assigns owners today, a `lody task`
  command would tomorrow) and must stay general. Do not "simplify" by pushing it down.
- `lody_task_create` vs `lody_task_propose` splits on WHO ASKED (user request →
  create now; agent-noticed follow-up → proposal card) and that split lives in the tool
  descriptions on purpose. A forced justification field was considered and rejected:
  it taxes every call to police a boundary whose error cost is one `canceled` task or
  one ignored card. The proposal writer is a one-shot manager: it must hydrate the
  Session doc before its idempotent upsert, flush locally, and confirm remote doc sync
  before returning `ok`; otherwise fast cleanup can strand a card only in local SQLite.
- MCP create takes run config semantically (`modelId`/`reasoningEffort`/`fastMode`/
  `planMode`), never raw ACP option ids. `@lody/shared` `acp-run-config.ts` owns the
  mapping onto each agent's advertised option ids (also the source of truth for the
  web selectors), `applyAgentRunConfigSelection` in `src/commands/session.ts` applies it
  once the target agent's cached capabilities are read, and
  `validateSessionCreateOptions({ dispatchConfig })` resolves the effective dispatch
  config before the Operation is accepted (it no longer rejects on capability
  evidence — see the snapshot invariant below). `lody_session_create_options` publishes the valid
  values per agent config as `runConfig`. Its default response is sparse: online Machines,
  one default/current agent config, the current local project, and no GitHub repository
  fetch. Agent configs/local projects/repos expand only through their query inputs.
  Durable create acceptance stores each target's resolved effective dispatch config;
  recovery must use it instead of inheriting again from mutable requester history.
- INVARIANT: a capability snapshot never rejects a run config. `configOptions`
  describes the model that was current when it was captured — and every created
  session rewrites it (`scheduleCreatedSessionCapabilityUpdate`), so it describes
  whichever model ran last. Neither a missing option, nor a value outside the list
  it recorded, nor an unseen model/mode id is evidence about the model a turn
  selects. `validateTurnConfigOptionValues` therefore rejects only what no model
  could carry: a value the option's own declared TYPE forbids. Everything else is
  dispatched and reconciled against the state the agent publishes.
  Do not reintroduce a `validatedConfigIds`-style exemption set, nor an offline
  classification of what "could not be confirmed": both only made sense while the
  snapshot could reject. With rejection gone there is nothing to exempt, and a
  classification nobody reads is not a diagnostic — the runtime divergence
  comparison is the report.
  INHERITANCE is the one place that still drops:
  `filterInheritedTurnConfigOptionValues` keeps an uncataloged key only when
  `isAcpPerModelConfigId` recognises it. A value carried forward from an older
  turn is not a request — nobody asked for it on this turn — so a removed or
  renamed option would otherwise ride the Session lineage forever: every new
  Session inherits it, the agent rejects it, and that config becomes the next
  inheritance source, with no surface anywhere to clear it. The same rule applies
  when there is no capability at all; an explicit request is always available, so
  a missing snapshot must not become a licence to carry every historical key.
  Explicit `--config-option` and frozen Operation requests keep going out
  unchanged — that split is the whole point.
  The one thing that still fails loudly is a missing wire BINDING — no snapshot
  option and no agent convention for how to spell a control, so there is no
  request to send and an invented id would be a silent no-op. That is a different
  statement from "unsupported" and must be worded as such.
  `acp-capability-normalization.ts` still recovers `modelReasoningEfforts` from the
  legacy `model[effort]` list (Codex): a published per-model breakdown CONFIRMS a
  value for the selected model, which is the only thing that keeps it out of
  `unverifiedSelections`. It never rejects one.
  Client side: a Role may be seeded only from `authoritative` capabilities —
  `provisional` means the built-in static tables, and seeding from those persists a
  guess as a durable promise. Nor may it be SAVED without one: a Role is its run
  config and pins the permission mode, so `validateAgentRoleForm` refuses a new
  Role while capabilities are unreported (`run_config_unavailable`), keyed on
  CREATION rather than on the value being empty: the chat landing and the input
  area both create a Role from what the composer currently shows, and under
  `provisional` capabilities those are the static tables' own defaults — a
  non-empty run config nobody chose. Editing an existing Role stays open, so its
  owner can rename it while the machine is offline. The composer keeps stored keys its selector catalog
  does not cover; only a present runtime table (the agent's live state) owns the
  whole key set. Runtime rejections remain in debug diagnostics; what becomes a visible
  `agent_warning` is DIVERGENCE — the state the agent publishes after applying the
  turn's config contradicts what was requested. A rejection is not that signal in
  either direction: Codex accepts `fast-mode` on a model with no fast speed tier and
  then omits the option from its published state, so the state is the only evidence
  Fast is off, while a rejected value that was already effective changed nothing and
  must stay silent. Only where the agent published no config options at all (or for a
  sensitive id, which the runtime state deliberately omits) does the failed call
  remain the sole signal. Do not restore a per-agent suppression list: it silenced
  exactly the per-model controls users most need told about. Compatibility exception:
  Claude Fable models omit the Fast mode option, so an explicit `fast=false` is
  skipped as an already-effective no-op and is judged for neither; `fast=true` must
  still be dispatched and retained in debug diagnostics if rejected.
- INVARIANT: permission-bearing config (the mode option, plan/collaboration mode)
  is applied LAST, after the model and the ordinary options. Claude rebuilds the
  available permission modes on a model switch and downgrades the current one to
  `default` when the new model lacks it, so a mode set before the model is
  silently widened by the model that follows. `applyPromptConfig` runs before
  `prompt`, so the state read after applying is still taken before the agent acts.
  A successful `session/set_mode` is an acknowledgement, not proof of the resulting
  state: it may only FILL a mode the agent's own state does not report, never
  overwrite one — echoing the request back as the outcome makes every mode
  divergence invisible. Divergence is reported, not blocked: no run-config
  mismatch may prevent Session creation or prompt submission, and Agent Roles and
  frozen Operations behave exactly like ordinary preferences at run time,
  differing only in warning wording and follow-up marking. A Role that would run
  diverged is surfaced, not refused — an upgrade must never turn a Role that used
  to run into one that fails.
  EXCEPTION, and the only one: when the agent's own reported final state says the
  turn would run with MORE permission than it asked for, the turn fails before
  `prompt` (`AcpPermissionNotAppliedError` → `permission_not_applied`). By the
  time a warning about that is readable the agent may already have edited files,
  so this is the one divergence a notice cannot cover. It fires only on a live
  contradiction. Permission arrives in THREE shapes and all three are checked:
  the legacy `session/set_mode` selector, a `category: 'mode'` config option, and
  an explicit `category: '_permission'` one (Grok's `permission_mode`, values
  `ask`/`auto`/`always-approve`). Matching only the first two let a requested
  `ask` run as `always-approve` with nothing but a warning. Each requested
  permission-bearing value is compared against the agent's reported value for
  THAT control; `isAcpPermissionWiderThanRequested` requires BOTH values to be
  ranked among the builtin ones and the effective one to be strictly wider, and
  the effective value is read from the agent's published state — a snapshot, a
  stale cache, an unranked third-party mode, an unconfirmed request, or a
  NARROWER outcome must never stop a turn. The rank table covers only values the
  repo adapts (Codex, Claude, Grok `ask`/`auto`/`always-approve`, DeepSeek
  Harness `read-only`/`workspace-write`/`danger-full-access`); adding an agent
  means adding its values there, or its escalations go unseen. The way out is explicit and
  per-turn: `SessionTurnInputConfig.acceptWiderPermission` is informed
  acceptance carried by one resend, never inherited and never a default, and it
  suppresses the stop while still reporting the mismatch. It NAMES the exact
  difference that was disclosed — `{ controlId, requestedModeId,
  effectiveModeId }`, written from the failure notice's own meta — because a
  bare boolean also accepts differences the user never saw: the agent may have
  moved further by the time the turn re-runs (`plan → auto` accepted, `plan →
  always-approve` live), and a second permission control may have widened
  alongside the one in the notice (Grok carries both a mode selector and an
  explicit `_permission` one). The applier skips ONLY exact triple matches and
  keeps scanning the remaining permission selections, so anything undisclosed
  stops the turn again with its own accurate notice.
  It is a LIST (`acceptWiderPermissions`) because those differences are
  disclosed one stop at a time: two controls widening at once produce two
  notices, and a replay carrying only the newest acceptance would drop the
  previous one and land back on the first — the user alternates between two
  notices with no way through. A retry therefore inherits the acceptances
  already on the turn it is replaying, re-validated, and appends the current
  notice's triple. Accumulating grants nothing extra, because every entry is
  still matched exactly. An ordinary send, edit-and-resend and any prompt-derived
  turn clear the whole set; a same-turn transport retry keeps it. Do not match on the values
  alone, and do not treat a rank ceiling as equivalent across different
  permission controls. The notice meta and the acceptance share ONE schema
  (`AcceptedWiderPermissionSchema`): the client reads the meta and writes it
  straight back, and Zod strips undeclared keys, so a second declaration drops a
  field on every history read — the action then disappears from a failure the
  daemon reported correctly. A malformed or pre-triple `permission` degrades to
  absent rather than failing the parse, so the notice still renders and simply
  offers no acceptance. That resend replays the
  STOPPED turn: prompt, mode, model, config values, Role, `mcpServerIds`
  (including an explicit empty selection), `taskToolsEnabled` and
  `issuePRMentions` all come from its frozen `inputConfig`, never from the
  composer — pairing an old prompt with tool reach the user has since changed
  would hand it permissions that turn never had. Those fields travel as ONE
  required `TurnScopedOverrides` carrier through every send route (direct,
  queue, guide), because each route rebuilds the turn config from composer
  state: a route that forwarded three of four silently produced a turn with no
  acceptance, which the daemon stopped again. Required, not optional, so a new
  route fails to compile rather than dropping it. The same field must survive
  every REBUILD on the way to the daemon, and there are three hand-written ones:
  `normalizeSessionTurnInputConfig` (which direct RPC, `session/dispatch-turn`,
  steer, the Loro history readback and queue promotion all run the config
  through), the dispatch watcher's two `acpSessionConfig` constructions, and
  queue promotion's `buildSessionTurnInputConfig` call. A rebuild that omits it
  stops the very turn the user just accepted. Each copies ONLY an explicit
  `true`: `false` and absent are the same answer, and neither may be written
  back as something a later turn could read. `buildCliHistoryInputConfig` is the
  deliberate exception — CLI and MCP turns never carry an acceptance, and it
  must not become inheritable there.
  The mirror image is just as load-bearing: making the field survive rebuilds
  also made it copyable. Any derivation that mints a new `userTurnId` or changes
  the prompt/input blocks — edit-and-resend, history replay import — must go
  through `deriveTurnInputConfigForNewTurn`, which drops it. The acceptance was
  given for ONE prompt; carrying it onto another is a permission bypass built
  out of a spread. Same-turn rewrites (status, `_lodyDeliveryKind`, transport
  retry) are not copies and keep it.
- MCP `session_list` defaults to 20 (maximum 100), and `session_history` defaults to 10
  (maximum 50 and 128 KiB). Keep the MCP surface bounded even though the human CLI retains
  `session history --all`. `session_list` and `session_status_many` derive busy/idle from
  the same history, durable queue, presence, and Machine RPC snapshot. Operation/Delivery
  implementation invariants live in
  `src/orchestration/AGENTS.md`; normative behavior lives in
  `specs/session-orchestration.md`.
- Dispatch point-of-no-rollback (`createSessionResult` / `sendSessionChatResult` in
  `src/commands/session.ts`): `writeDispatchPointer` commits `latestUserMsgId` to the
  local repo, after which the daemon may already be executing the turn. Cloud
  confirmation is a separate `confirmDispatchSyncedBestEffort` step that is AWAITED (so
  the push completes before the one-shot `withWorkspaceManager` transport is torn down)
  but NEVER throws — the durable pointer plus the SQLite Operation own delivery, and the
  repo reconciles on its own schedule. The create/chat `catch` must only unwind when the
  pointer was NOT yet written (`if (!dispatched)`); rolling back after dispatch deletes an
  already-running session out from under the daemon and drops its generated title. Do not
  reintroduce a hard-fail Streams ack on the dispatch write.
- A renderer joining a local data-plane Session Doc room must not call
  `LoroDocumentManager.getOrCreateSessionDoc` or retain a live cloud room.
  Renderers may visit thousands of historical sessions; coupling local join to a
  `SessionDocument` retains them until GC and can starve the Host health endpoint. Use the
  bounded raw-doc one-shot reconciliation in `loro/doc.ts`, cancel it on local leave or
  Session activation, and unload renderer-only docs after the last peer leaves. Session
  metadata/RPC activation owns persistent CLI cloud joins. Flock room bridging remains
  explicitly paired to local Flock join/leave.

## Agent feedback

- `lody feedback` and MCP `lody_feedback` submit only caller-provided suggestion text.
  The shared client adds only CLI version, platform, and architecture. Do not add cwd,
  paths, hostname, environment, logs, prompts, conversation history, or file contents.
- Keep obvious-secret rejection in both the CLI and hosted API boundary; instructions alone
  are not the privacy boundary.

## GitHub auth shortcut

- Custom and Registry ACP authentication uses a temporary protocol connection: initialize,
  select an advertised agent-driven method, then call ACP `authenticate`. Deprecated `env_var`
  methods are rejected rather than revived as a second credential protocol, and terminal methods
  remain unavailable until Machine RPC has a real interactive terminal bridge. Request-scoped URL
  and text/secret/single-select form elicitations are bounded, validated, and bridged one at a time
  to Machine RPC progress; URLs must use HTTP(S). Replies stay ephemeral; secret defaults and raw
  authentication-process output never enter retained progress. Renderer cancellation and the
  CLI-owned deadline must abort the ACP request and terminate its whole process group, including a
  timeout that lands during cleanup. A capability refresh after login remains the proof that
  credentials actually became usable and must finish inside the renderer's 300-second workflow
  deadline.

- Agent `gh` auth for GitHub repo sessions is managed in
  `src/session/session-manager.ts`: it creates the git credential broker, prepends the
  `~/.lody/bin/gh` shim, and injects/refreshes a managed `GH_TOKEN` when no user token
  is present. The shim lives in `src/lib/gh-shim-script.ts`; token fetching/caching is
  in `src/lib/github-token-manager.ts`; git HTTPS auth uses
  `src/lib/git-credential-helper-script.ts`.
- INVARIANT: host-side git must receive its credential broker as an explicit argument
  (`WorktreeManager.ensureRepo({ brokerAuth })`), never from ambient `process.env`.
  A fleet process runs one `GitCredentialBroker` per workspace, each bound at
  construction to its own workspace-scoped `GitHubTokenManager`, and every one of them
  writes the same process-global `LODY_GIT_CRED_BROKER_*` pair plus the shared
  `~/.lody/broker.json`. The ambient value therefore belongs to whichever workspace
  started or recovered its broker LAST — and `ensureStarted()` early-returns once
  started, so the correct workspace never takes the pointer back. A session in
  workspace A then authenticates through B's token manager and fails with
  `repo_not_linked` → `terminal prompts disabled`, while A's own prefetch succeeds.
  Keep `brokerAuth` a per-call argument: `getWorktreeManager` caches by `repoId` alone,
  so two workspaces sharing a repo share one manager instance. Session process trees are
  already correct (`prepareGitHubRepoSessionConfig` injects the env explicitly); the
  helper's connection-refused fallback is scoped by `LODY_GIT_CRED_BROKER_STATE_FILE`
  (per-workspace `broker-<workspaceId>.json`) for the same reason. Diagnostics must
  probe the same broker the failing command used, or they report a misroute as the
  caller's workspace lacking the repo link.
  Regression test: `src/session/worktree/worktree-manager-broker-auth.test.ts`.

## PR status reconciler

`src/lib/pr-poller/` reconciles PR discovery/association, lifecycle, CI
rollup, and merge/conflict state for this machine's sessions — the
compensation path when the hosted GitHub webhook → Streams fan-out breaks.
Normative spec: `specs/pr-status-reconciler.md`. `PrStatusPoller` is
constructed in `LodyFleet.start()`; per-workspace handles
(`pr-poller-workspace.ts`) are fact sources + write-back destinations only.
All policy lives in pure modules (targets, priority, quota, selection,
provider projection, write-back planning); the scheduler is a thin
orchestrator. Priority comes from `session-viewing` presence and
`lastMessageAt` activity (high lane 20s, low status 5min, no-PR discovery
20min) — there is NO turn-end hook. Batched GraphQL per `(workspace, repo)`
under a per-credential-scope point bucket, provider safety-floor freeze, and
15min→2h repo cooldowns. Write-back plans against freshly read owner meta:
`pullRequests` upserts by URL with the current PR as the LAST item (legacy
fields stripped once), CI/merge live in `SessionMeta.pullRequestState`
(`{s,m,t}`, ≤50B/entry; legacy `r` readiness is no longer written and is
deleted on touch). Scheduling state (never PR status) is in
`~/.lody/pr-poller-state.json`. Env: `LODY_PR_POLL_DISABLED=1` kill switch,
`LODY_PR_POLL_*` overrides (`pr-poller-config.ts`). Module invariants live in
`src/lib/pr-poller/AGENTS.md`.

## ACP adapter provenance

Terminal output history is bounded separately from agent execution output. Read
context/terminal-output-lifecycle.md before
changing ACP terminal notification handling or history compaction.

Builtin Claude/Codex/Grok use bundled adapters plus managed native runtimes; builtin Kimi
launches its managed Node package directly. `src/agent/setting.ts` resolves those four
through `src/agent/managed-agent-runtime.ts`. Builtin DeepSeek Harness is deliberately not
a managed runtime: `src/agent/deepseek-harness-runtime.ts` consumes the pinned profile from
the `packages/acp-extension-dsh` submodule, launches it through Lody's isolated npx cache,
and loads the bundled `deepseek-acp.js` adapter. The extension owns the ACP model,
reasoning-effort, and permission selectors while Harness
continues to own model execution, sandbox enforcement, and one-shot approvals. See
managed runtime context and the
builtin extension checklist.

Built-in provider auto-registration runs from `src/lib/lody.ts`. Provider configs
live in the current machine Flock doc, so registration starts only after the Fleet's
workspace subscription confirms remote identity/access and the remote bridge attaches.
It must then wait for initial meta sync and a confirmed `syncMachineFlockDoc()` before calling
`hasAgentConfig`/`createAgentConfig`; otherwise a stale local doc can create
duplicate built-in configs. If machine Flock sync is not confirmed,
keep a deferred backoff retry instead of dropping the registration attempt.

The adapter packages in `apps/cli/package.json` are public submodule dependencies.
Adapter bugs/behaviors should be fixed in their package sources first:

- `claude` → `packages/acp-extension-claude`, source:
  https://github.com/LodyAI/acp-extension-claude
- `codex` → `packages/acp-extension-codex`, source:
  https://github.com/LodyAI/acp-extension-codex
- shared extension contracts → `packages/acp-extension-core`, source:
  https://github.com/LodyAI/acp-extension-core
- `deepseek` → `packages/acp-extension-dsh`, source:
  https://github.com/LodyAI/acp-extension-dsh

Both adapters ship from these workspace sources; debug behavior there first.

Clean checkouts do not have adapter `dist/` outputs, and existing checkouts may have
stale outputs after a submodule update. Keep `apps/cli`'s `prepare:acp-adapters` step
before both `scripts/dev-build.mjs` in the CLI `dev` script and Vite in the CLI `build`
chain. The `src/claude-acp-entry.ts` / `src/codex-acp-entry.ts` entries import the
adapters' package roots, whose runtime exports point at adapter `dist/`; skipping
preparation can silently launch old capabilities even while the adapter source is current.

When debugging Codex-side ACP behavior (tool_call update shapes, collaboration events,
goal metadata, image generation, history recovery), check the workspace adapter source
first. Managed runtime artifact pins and checksums live in
`src/agent/managed-agent-runtime.ts`; artifact production and publication are
external distribution responsibilities. Observed per-agent edit-evidence behavior and
the ACP protocol reference are documented in `context/acp-protocol.md` and
`context/acp-agent-edit-evidence.md`.
