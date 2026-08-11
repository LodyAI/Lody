# apps/cli/src/agent — Index

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

ACP client side of the CLI (spawning and talking to coding agents). Protocol reference:
context/acp-protocol.md; per-agent edit-payload
quirks: context/acp-agent-edit-evidence.md;
adapter source repos: [apps/cli/AGENTS.md](../../AGENTS.md). Where updates go after they
arrive: context/message-flow.md "Upstream".

- `agent-client.ts` — the ACP connection: initialize/session lifecycle, client
  capabilities (fs, elicitation), permission/fs request handling, update callbacks.
  Goal session-info updates use provider-neutral `_meta.goal`; keep the
  `_meta.codex.goal` reader only as a compatibility fallback for older Codex adapters.
  A present neutral field wins, including `null`, so malformed new metadata is not
  silently hidden by a legacy duplicate. Validate neutral snapshots against
  `controlMethod: _session/goal`; normalize neutral `limited` to the legacy durable
  `blocked` status so older readers can consume mixed-version history without
  inventing a provider-specific limit reason.
  Its built-in `lody` stdio MCP config is an explicit environment allowlist, not
  ordinary child-process inheritance. Keep the public CLI deployment endpoints
  (`LODY_AUTH_URL`, `LODY_AUTH_SITE_URL`, `LODY_SERVER_URL`) in that config so
  cloud MCP session orchestration uses the same deployment as the daemon; local
  platform assembly clears those values before agent startup, so a local child
  cannot inherit Lody cloud endpoints. Never add
  CLI credentials or other secrets; the MCP subprocess loads the daemon owner's
  local credential through the existing CLI auth path.
  Acknowledged steer is inject-or-refuse, and `AgentSteerNotDeliveredError` marks
  ONLY the provable refusal: a local pre-write failure, or the agent's own
  JSON-RPC `invalid request` answer. A closed connection, a dead agent process, or
  an internal error may have left the prompt inside the live turn — the caller
  re-sends an undelivered steer, so widening that classification sends the user's
  message twice. The applied-waiter must also wait for the steer request's own
  answer before giving up on the upstream turn's response: the Codex adapter drains
  session notifications before refusing, so the turn's response routinely wins that
  race and would otherwise mask the refusal.
- `acp-runner.ts` — process spawn/restart around the client.
- `setting.ts` — launch resolution. Builtin Claude/Codex/Kimi require
  `resolveACPProcessLaunchAsync()` because they may install Lody-managed native
  or Node-package runtimes and then spawn bundled adapter entries.
- `managed-agent-runtime.ts` — pinned Codex/Claude Code native and Kimi Node-package `.tar.zst`
  artifacts, checksums, resumable downloads, the active installation profile's
  `agent-binaries` layout, and best-effort `bin` symlinks for complete native CLIs.
  Its artifact base URL is injected from `CloudPort.runtimeArtifacts`; do not read
  deployment environment or derive the channel inside the runtime manager. Local
  and cloud process assembly share the public R2-backed default owned by
  `@lody/platform`; `LODY_RUNTIME_BASE_URL` is an explicit mirror override. Repacked Node packages
  intentionally do not publish a convenience link because non-ACP subcommands may be omitted.
  Concurrent installs share one internal download but keep independent consumer leases;
  cancelling one caller must not stop other consumers, while cancelling the last caller aborts
  cancellable fetch, checksum, and extraction work. A fully validated install that has already
  crossed the final complete-marker commit may remain as a safe cache hit even though that caller
  observes cancellation. An immediate retry waits for an earlier aborted generation's scratch
  cleanup before starting a new generation for the same artifact.
- `acp-authentication.ts` — trusted builtin authentication lifecycle. Kimi runs
  `acp --login`; Claude Code runs the official `auth login --claudeai`
  subscription flow; Codex always runs the official `login --device-auth`
  ChatGPT flow so Web can complete authentication against a remote machine.
  `acp-authentication-output.ts` incrementally converts bounded provider output
  into allowlisted authorization URLs, device codes, expiry, and Claude's
  optional browser-returned code input. Provider processes own credentials;
  authorization data must never enter logs, chat, Flock, or config. Remote Web
  transport stores only an ephemeral-ECDH/AES-GCM envelope in the 24-hour request
  stream; the target machine keeps the recipient private key in memory and decrypts
  immediately before stdin. Local UI and CLI state is in memory. Raw output progress remains only as a temporary
  old-renderer compatibility field.
  Claude capability refreshes first run its native status command so missing
  credentials become structured auth-required state before adapter startup;
  explicit environment-authenticated paths bypass the native status check and
  remain under adapter validation. Codex authentication requirements come from
  ACP session creation because `codex login status` cannot account for custom
  model providers with `requires_openai_auth = false`. The per-agent slot covers async
  launch preparation as well as the child process, so cancel and concurrent start cannot race spawn;
  timeout/cancel terminate and release the slot for Retry.
- `acp-binary-manager.ts` — registry binary-distribution agents. It follows the same
  consumer-lease cancellation rule as managed runtimes: one shared install, abort only after
  the last consumer leaves, and never reuse an aborted generation while it is cleaning up. Tar
  and zip extraction must attach to the shared abort signal. ZIP cancellation destroys the
  current yauzl endpoint, awaits the relay/output pipeline, and fences cleanup on the underlying
  random-access reader's real close/error event. Do not await the yauzl endpoint itself: its
  overridden `destroy()` does not settle. Network failures retain the URL plus nested transport
  cause for diagnostics.
- `npx-cache.ts` — npx cache isolation + poisoning detection/purge for resilient
  registry launches. ACP `npx` spawns force `npm_config_cache`/`NPM_CONFIG_CACHE`
  to the active installation profile's `npm-cache` so user `~/.npm`
  permission/corruption issues cannot stop
  agent startup. Automatic `_npx`/`_cacache` cleanup is only allowed for that
  Lody-owned cache, never arbitrary user npm caches.
- `acp-capabilities.ts` / `acp-startup-monitor.ts` / `acp-analytics.ts` — capability
  cache, startup health, analytics. Default builtin Codex/Claude capabilities
  come from `getStaticBuiltinAcpCapabilities()` in `@lody/shared` only for
  `cliType: 'builtin'` without runtime overrides, so onboarding/settings/chat can
  render mode/model/config options without spawning adapters or downloading
  managed runtimes. Registry/custom agents and builtin runtime overrides still
  need the actual ACP agent. `machine/acp-capabilities-refresh` is always a real
  runtime probe: it disables static builtin capabilities, goes through
  `ensureRuntime()` for managed runtimes, then writes the machine capability
  cache keyed by `agentConfigId`. Its cancellation signal crosses native auth status,
  managed/registry download, and adapter startup; an aborted probe must not update the cache.
  Requests and responses carry that id so configs
  sharing a provider remain isolated. Real session creation also normalizes its `NewSessionResponse` through
  `acp-capability-normalization.ts`; the session execution service schedules a
  non-blocking cache update before the first prompt. Machine Flock writes ignore
  `fetchedAt` when comparing entries, so unchanged runtime capabilities do not
  commit or sync.
- `login-shell-env.ts` — login-shell env capture for spawned agents.
- Builtin Claude owns session title generation through ACP
  `session_info_update`; `AgentClient` forwards those titles and `MessageHandler`
  stores them only after `sanitizeLodyInternalInstructions`. It must not start
  `title-generator.ts`'s isolated ACP session. Builtin Codex still uses the
  isolated generator because its adapter emits the first user prompt as a
  fallback title when Codex has no explicit thread name. The shared
  `usesAcpProvidedSessionTitle()` predicate hides obsolete provider title
  settings only for Claude. Other providers use `title-generator.ts` /
  `response-utils.ts` for session titles.
