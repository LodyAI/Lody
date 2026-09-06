# CLI Agent Guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` applies; this file adds CLI context. Build, PR-poller, and adapter background:
[.agents/docs/cli-overview.md](../../.agents/docs/cli-overview.md). Scoped rules live under
`src/{agent,commands,session,mcp,orchestration,preview,lib}`.

## Build and packaging

- The public CLI defaults to the local platform, discovers no deployment dotenv files, and must
  never initialize telemetry in local mode even if PostHog variables exist in the shell.
- INVARIANT: the dev output layout must match production's — `index.js` plus flat sibling
  `claude-acp.js` / `codex-acp.js` / `*-worker.js` — because worker owners resolve their child by
  FILENAME next to `import.meta.url`. Keep npm packages external by ABSOLUTE path, keep
  `splitting: true`, and keep the no-hoisting assertion.
- Import the CLI's own `version` from `@/pkg`, never a relative `../package.json`; the package
  `name` stays `lody` in every composition.
- Keep `prepare:acp-adapters` before `dev-build.mjs` and Vite: skipping it can silently launch old
  adapter capabilities from a stale `dist/`.
- `engines.node` is pinned to `>=22.14.0` by better-sqlite3's `NAPI_VERSION=10`, and
  `src/utils/sqlite-runtime-support.ts` must stay the FIRST import in `src/index.ts` — older Node
  segfaults on the SQLite binding instead of throwing.
- Read [apps/electron/AGENTS.md](../electron/AGENTS.md) — embedded packaging, native deps/ABI,
  child runtime env, and the three places the Node pin moves together — before changing runtime
  deps, bundle externals, or spawning `process.execPath` with a filtered environment.

## Coding rules

- Prefer Effect TS idioms for new/refactored CLI code — services via `Context.Tag` + `Layer`,
  typed errors, structured concurrency, `Schedule` retries: context/cli-effect-ts.md.
- Keep the strict tsconfig, no `any` or non-null assertions, and Zod at every foreign boundary:
  context/cli-type-safety.md.
- After a remote prompt arrives, only correctness-critical setup may block before ACP
  `agent.prompt`; never await notifications, analytics, or UI summaries
  (context/cli-prompt-hot-path.md).
- Startup order and timing traces: context/cli-startup.md. Local logs: context/cli-logs.md.
- Read context/local-agent-ownership.md before changing local ports/sockets, daemon PID state,
  Electron/daemon startup, Supervisor retries, or Worker shutdown; health probes are observation
  only and never authorize PID killing.
- Read context/terminal-output-lifecycle.md before changing ACP terminal notification handling or
  history compaction.

## MCP tool surface

- MCP session tools use stable machine/session/agent-config ids and strict, narrow input schemas.
  Create/chat Commands require a caller-chosen Operation id, and Create persists the Operation
  before its fallible availability step: a transient post-accept failure returns the active fixed
  target for daemon replay, and `session_create({ operationId, resume: true })` recovers it without
  the prompt. Completion is delivered automatically — no public wait tool — and legacy `wait=true`
  is a temporary adapter new callers must not use.
- Child Sessions are one level deep. An independent Session created inside another persists exact
  provenance in `openedBySessionId`, plus `openedByRootSessionId` when the opener is a child Tab;
  never rewrite the exact opener to the root or treat either as `parentSessionId`.
- `lody_session_create_options` publishes valid run-config values per agent config and stays
  sparse by default (online Machines, one agent config, the current local project, no GitHub
  fetch), expanding only through explicit query inputs.
- INVARIANT: reasoning effort and fast mode are per MODEL, because an ACP probe's `configOptions`
  describe only the model current at probe time. Validate effort against the TARGET model using
  `AcpCapabilityCacheEntry.modelReasoningEfforts` and skip the resulting `validatedConfigIds` in
  `validateTurnConfigOptionValues`; dispatch what cannot be checked offline as requested. Keep
  runtime rejections in debug diagnostics: Codex/Claude mismatches for model, effort, Fast, or Plan
  never become visible `agent_warning` notices, while other rejections still do. Claude Fable
  models omit Fast, so `fast=false` is skipped as a no-op while `fast=true` is dispatched.
- `session_list` defaults to 20 (maximum 100) and `session_history` to 10 (maximum 50 and 128 KiB);
  keep the MCP surface bounded though the CLI retains `session history --all`. `session_list`
  and `session_status_many` derive busy/idle from the same history, durable queue, presence, and
  Machine RPC snapshot. Operations: `src/orchestration/AGENTS.md`, `specs/session-orchestration.md`.
- Bound every task reply: body 64 KiB with head-and-tail truncation
  (`bodyTruncated`/`bodyOmittedBytes`), newest 20 comments with `commentCount`, 50 links,
  `lody_task_list` 20/100 with `matched`. `lody_task_edit_body` still matches exactly against the
  FULL body server-side.
- `lody_task_list` reads the Task Index Flock ONLY: never open task documents on a list path, and
  never return `order`.
- `lody_task_update` writes every scalar property EXCEPT `agent`, and never the body: the body goes
  through the exact-match edit, and `agent` is the sole automation consent.
- INVARIANT: `status`, `ownerId`, and `projects` all sit in the delegated-automation eligibility
  predicate (`planTaskAutomation`), so an agent write to any of them can START a session on an
  already-entrusted task; anything in that predicate is an execution trigger. Its attributed
  activity entry is an audit record, NOT a user-visible notice.
- `ownerId` on an agent WRITE accepts ONLY `""` (unassign) — `TaskOwnerIdWriteSchema` — because
  naming an owner points `isTaskAutomationEligible` somewhere new and could route a task into
  execution under this operator's credentials on someone else's consent; it also disposes of the
  `me` filter sentinel. Keep that restriction at the MCP boundary, NOT in `task-doc.ts`.
- `lody_task_create` versus `lody_task_propose` splits on WHO ASKED (user request → create now;
  agent-noticed follow-up → proposal card), and that split lives in the tool descriptions on
  purpose. The proposal writer hydrates the Session doc, flushes locally, and confirms remote sync
  before `ok`.
- `lody feedback` and MCP `lody_feedback` submit only caller-provided suggestion text plus CLI
  version, platform, and architecture — never cwd, paths, hostname, environment, logs, prompts,
  history, or file contents. Keep obvious-secret rejection in the CLI and the hosted API boundary.

## Agents, GitHub, and PR status

- ACP authentication rules: [src/agent/AGENTS.md](src/agent/AGENTS.md). A capability refresh after
  login proves credentials became usable and must finish inside the renderer's 300-second deadline.
- Agent `gh` auth for GitHub repo sessions is set up in `src/session/session-manager.ts`; the
  host-side credential-broker INVARIANT is in [worktree](src/session/worktree/AGENTS.md).
- Built-in provider auto-registration (`src/lib/lody.ts`) must wait for initial meta sync and a
  confirmed `syncMachineFlockDoc()` before `hasAgentConfig`/`createAgentConfig`, or a stale local
  doc creates duplicate configs; unconfirmed sync keeps a deferred backoff retry.
- `DEEPSEEK_BASE_URL` is a capability-bearing launch input: digest its exact value into the
  DeepSeek capability source version and thread the Agent config environment through every
  probe/session source-version derivation, so two endpoint catalogs never share a cache identity.
  Never put the API key or a derivative of it in that cache key.
- `src/lib/pr-poller/` compensates for a broken hosted GitHub webhook → Streams fan-out. Keep
  policy in its pure modules with a thin scheduler, keep priority driven by presence and
  `lastMessageAt` rather than a turn-end hook, and keep only scheduling state (never PR status) in
  `~/.lody/pr-poller-state.json`. Spec: `specs/pr-status-reconciler.md`; invariants:
  `src/lib/pr-poller/AGENTS.md`.
