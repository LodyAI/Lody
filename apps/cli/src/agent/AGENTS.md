# apps/cli/src/agent — Index

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

ACP client side of the CLI (spawning and talking to coding agents). Protocol reference:
context/acp-protocol.md; per-agent edit-payload
quirks: context/acp-agent-edit-evidence.md;
adapter source repos: [apps/cli/AGENTS.md](../../AGENTS.md). Where updates go after they
arrive: context/message-flow.md "Upstream".

- `agent-client.ts` — the ACP connection: initialize/session lifecycle, client
  capabilities (fs, elicitation), permission/fs request handling, update callbacks.
  Lody ACP extensions are consumed through `acp-extension-core`: capability discovery
  lives at `agentCapabilities._meta.lody`, session metadata at `_meta.lody`, and custom
  methods use the Core `_lody/...` names. Provider-specific and pre-Core readers belong
  only in the central compatibility adapter and must not leak into session consumers;
  normalized Core capabilities remain provider-neutral.
  Builtin Grok must default `clientCapabilities.terminal` to false so its adapter
  uses Grok's local terminal runner. Its ACP terminal request encodes a full shell
  command line in `command` with empty `args`, which is not the executable-plus-argv
  contract that Lody's sandboxed terminal manager preserves for other agents.
  Config selected by the driving turn travels on every session establishment as
  `_meta.lody.sessionConfig`; provider-specific startup translation belongs in the
  ACP adapter. `session/set_config_option` remains the live-session switch, and a
  successful selection becomes the startup state of a later replacement. Session
  setup and `session/set_config_option` responses carry the agent-confirmed config
  state; runtime projections must consume them as well as autonomous
  `config_option_update` notifications. Presence of `configOptions`, including an
  empty array, is an authoritative full snapshot and replaces retained startup
  values; only an omitted field uses the legacy request-value fallback. That
  fallback updates both replacement-session startup state and the matching
  advertised option's effective `currentValue`, so shared runtime projection
  cannot publish a stale value after the agent accepts a request.
  Goal snapshots use the Core `_meta.lody.goal` contract and epoch-second field names;
  convert them to the durable millisecond fields at this boundary. Normalize `limited`
  to the legacy durable `blocked` status.
  The built-in `lody` MCP server has TWO transports. Agents whose initialize
  response advertises `mcpCapabilities.http` get a shared HTTP endpoint served
  by ONE host subprocess per daemon (`src/mcp/lody-mcp-http-host.ts`, supervised
  by `src/mcp/lody-mcp-http-server.ts`); everything else keeps the per-session
  stdio entry. INVARIANT: MCP tools must not run inside the daemon process —
  they do synchronous SQLite work (`orchestration/operation-store.ts` restricts
  that to subprocess boundaries) and one-shot workspace-manager work that would
  stall the daemon event loop. The supervisor keeps token+port stable across
  host restarts because sessions bake the endpoint into their MCP config at
  creation; while the host is down, new sessions silently fall back to stdio.
  HTTP security: loopback bind + bearer token, and on Linux the peer socket's
  uid is proven via `/proc/net/tcp{,6}` (full four-tuple + ESTABLISHED) and an
  unprovable peer is REJECTED — the token leaks through the agent runtime's
  `/proc` cmdline there, so fail-open would void it. The host refuses to start
  when `/proc/net/tcp` is unreadable. `LODY_MCP_HTTP_DISABLED=1` forces stdio.
  The stdio config remains an explicit environment allowlist, not ordinary
  child-process inheritance. Keep the public CLI deployment endpoints
  (`LODY_AUTH_URL`, `LODY_AUTH_SITE_URL`, `LODY_SERVER_URL`) in the stdio config so
  cloud MCP session orchestration uses the same deployment as the daemon; local
  platform assembly clears those values before agent startup, so a local child
  cannot inherit Lody cloud endpoints (the HTTP host inherits the daemon's own
  environment directly). Never add CLI credentials or other secrets to the
  stdio config; MCP processes load the daemon owner's local credential through
  the existing CLI auth path.
  Builtin DeepSeek Harness mounts this stdio server per ACP session through the
  extension's native `dsh-mcp-client` bridge. Keep passing the same config on
  initial and replacement sessions; the bridge owns namespace collision handling
  and releases the MCP child with `session/close` or Agent teardown.
  The same session entry carries the driving Turn's `taskToolsEnabled` bit (HTTP header or
  stdio allowlisted environment). Missing/false keeps the Lody MCP server itself mounted but
  removes every `lody_task_*` tool; a replacement or restored ACP session must preserve that bit.
  Workspace MCP resolution is TWO phases and must stay that way:
  `loadExternalMcpServers` (catalog sync + document read) is invoked BEFORE
  `initialize` so its remote round trip overlaps spawn and the handshake, and
  the selector it resolves to applies the agent's advertised `http` capability
  at `newSession`. Awaiting the load between `initialize` and `newSession` puts
  a remote sync — up to its 5s budget — on the critical path of every session
  establishment while the agent process sits idle.
  Acknowledged steer is inject-or-refuse, and `AgentSteerNotDeliveredError` marks
  ONLY the provable refusal: a local pre-write failure, or the agent's own
  JSON-RPC `invalid request` answer. A closed connection, a dead agent process, or
  an internal error may have left the prompt inside the live turn — the caller
  re-sends an undelivered steer, so widening that classification sends the user's
  message twice. The applied-waiter must also wait for the steer request's own
  answer before giving up on the upstream turn's response: the Codex adapter drains
  session notifications before refusing, so the turn's response routinely wins that
  race and would otherwise mask the refusal.
  Registry Cursor opts into cursor-agent's clean model ids via
  `clientCapabilities._meta.parameterizedModelPicker` at initialize; the gate is
  registry identity (`cliType: 'registry'` and `agentType: 'cursor'`), never a
  same-named custom or builtin config. Downstream capability consumers stay
  provider-neutral.
- `acp-runner.ts` — process spawn/restart around the client. Spawn + initialize +
  `newSession`/`loadSession` share `acp-session-start-gate.ts` (default 2,
  `LODY_MAX_CONCURRENT_ACP_SESSION_STARTS`). Unbounded concurrent Codex starts
  each spawn a lody.exe adapter, a Codex app-server, and a lody.exe MCP child;
  they contend on `~/.codex` and freeze every in-flight session until Lody
  restarts. Do not add another ACP start path that bypasses the gate.
- `acp-session-start-gate.ts` — process-wide start semaphore used by
  `Session.createAgent`, `startLocalAcpAgent`, and history-catalog ACP spawn.
- `setting.ts` — launch resolution. Every builtin requires
  `resolveACPProcessLaunchAsync()`: Claude/Codex/Kimi/Grok may install Lody-managed
  native or Node-package runtimes, while DeepSeek Harness publishes an immutable
  Cordis composition before its npx launch.
- `deepseek-harness-runtime.ts` is the standard Harness-home (`DSH_HOME`, then `~/.dsh`),
  atomic-config, and npx launch wrapper around the `packages/acp-extension-dsh` submodule. It
  publishes Lody's versioned ACP composition beside (without replacing) user Harness config and
  launches the pinned explicit package closure through `dsh-acp-demo`; do not replace it with the
  all-in-one `@deepseek-ai/dsh` product CLI, because this ACP host deliberately excludes product UI
  and telemetry packages. CLI production and dev builds copy the extension's pinned official presets
  beside `deepseek-acp.js`; the generated roster also discovers `$DSH_HOME/.agent-presets`. The
  adapter must
  apply model and reasoning selection through the Agent-scoped request waterfall, permissions
  through Harness permission presets, and `agent_preset` through `AgentPresets.mount/recompose`;
  do not implement selectors as UI-only state. Presets may change only before the first prompt.
  ACP stdio/HTTP MCP servers are mounted dynamically per Agent and therefore belong in the
  extension adapter, not the immutable host composition.
  Credentials remain in the agent config environment (`DEEPSEEK_API_KEY`, optional
  `DEEPSEEK_BASE_URL`); never write them into the generated config. This is not a
  managed runtime and must not enter runtime download, prefetch, override, or
  interactive-auth flows.
  Harness JSONL roots are single-encoding stores. Before publishing the profile,
  inspect only the fixed artifact names: an empty or zstd root uses upstream's
  `zstd`, a raw-only legacy root keeps `none`, and a mixed root fails with both
  paths named. Detection and failure are read-only; never migrate, rename, or
  delete user session artifacts during launch or cleanup.
- `managed-agent-runtime.ts` — pinned Codex/Claude Code/Grok native and Kimi Node-package `.tar.zst`
  artifacts, checksums, resumable downloads, the active installation profile's
  `agent-binaries` layout, and best-effort `bin` symlinks for complete native CLIs.
  Completed caches written before metadata schema v1 remain reusable through a separate strict
  legacy schema; normalize their old `name`/`version`/`platform` fields in memory and infer only
  the trusted runtime definition's command and host requirement. Do not loosen the current schema
  or accept unknown legacy fields.
  Codex version/archive pins come only from `codex-runtime-manifest.json`, which the
  outer `mirror:agent-runtimes` operator command atomically refreshes from the exact
  official GitHub Release when the adapter's `@openai/codex` dependency changes.
  The CLI must reject a dependency/manifest version mismatch; never restore copied
  Codex checksum constants alongside the manager.
  Claude SDK/runtime archive pins likewise come only from
  `claude-runtime-manifest.json`. The mirror derives its sources and integrity from
  the adapter lockfile, regenerates all eight zstd archives after an SDK/runtime
  version change, verifies the canonical production objects, and then atomically
  updates the manifest. Do not duplicate Claude archive pins in the manager.
  Grok launches the pinned `acp-extension-grok` compatibility adapter with an
  official, unmodified R2-managed runtime in `GROK_PATH`. The submodule owns the
  private-wire contract and minimum official version; it is never the source for
  production runtime binaries.
  Kimi is different: `packages/acp-extension-kimi` owns the Lody-maintained runtime
  source and implements the shared `acp-extension-core` contract. Release automation must build
  that isolated workspace into the minimal checksummed Node-package artifact; the
  desktop still downloads the artifact and must not depend on the submodule workspace.
  Custom methods stay capability-gated, use the `_lody/` namespace, and never carry
  provider credentials or raw authentication output.
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
- `acp-authentication.ts` — the authentication lifecycle, with ONE slot, timeout,
  and cancellation policy shared by both of its paths. Which path runs is decided
  by the provider, not by the caller: a managed builtin runs its pinned login
  command, and everything else (registry and custom ACP) opens a temporary standard
  ACP connection in the same bounded lifecycle. Trusted builtin lifecycle: Kimi runs
  `acp --login`; Grok runs the official `login --device-auth`; Claude Code runs
  the official `auth login --claudeai`
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
  remain under adapter validation. Grok and Codex authentication requirements come from
  ACP session creation because `codex login status` cannot account for custom
  model providers with `requires_openai_auth = false`. The per-agent slot covers async
  launch preparation as well as the child process, so cancel and concurrent start cannot race spawn;
  timeout/cancel terminate and release the slot for Retry. Because protocol authentication
  spans launch preparation, JSON-RPC requests, and process cleanup, the running
  slot also carries an `AbortController` that termination raises before any child exists.
  Registry/custom initialization advertises no terminal capability and supports
  ACP URL plus form elicitation. Only agent-driven methods are runnable: `env_var`
  is deprecated and rejected, while `terminal` remains unsupported until Machine
  RPC has a real interactive-terminal bridge. Multiple methods and every elicitation
  stay on the original long-running request and permit only one pending interaction;
  replies carry an interaction id and use the encrypted authentication-input path on
  remote Machines. URL schemes, method/form sizes, ids, labels, options, and defaults
  are bounded before they enter progress; the form also has a shared serialized-byte
  budget so individually valid dimensions cannot multiply into an oversized RPC payload.
  Never forward raw third-party process output or secret defaults into retained progress.
  Machine RPC may name only a persisted Provider `configId`; the daemon resolves and freezes
  machine/CLI/agent/launch/env/runtime fields before spawning. Capability refresh follows the
  same rule because it also launches an ACP. Later authentication replies identify only the
  established request and interaction and can never replace its launch target.
  The real-process authentication test keeps method selection, versioned secret metadata,
  form submission, URL parsing, protocol stdout integrity, and process cleanup on one
  spawned ACP connection. The process is always stopped before success returns, and
  cancellation or timeout during cleanup must still win.
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
  cache, startup health, analytics. Default managed builtin Codex/Claude/Kimi/Grok capabilities
  come from `getStaticBuiltinAcpCapabilities()` in `@lody/shared` only for
  `cliType: 'builtin'` without runtime overrides, so onboarding/settings/chat can
  render mode/model/config options without spawning adapters or downloading
  managed runtimes. DeepSeek's static entry mirrors the bundled adapter's model,
  reasoning-effort, and permission selectors. Registry/custom agents and builtin
  runtime overrides still need the actual ACP agent.
  `machine/acp-capabilities-refresh` is always a real
  runtime probe: it disables static builtin capabilities, goes through
  `resolveRuntimeForLaunch()` for managed runtimes, then writes the machine capability
  cache keyed by `agentConfigId` and the runtime version actually launched. The
  resolver selects the pinned target, then the most recently installed reusable runtime,
  and blocks on `ensureCurrentRuntime()` only when no runtime is installed.
  `ManagedRuntimeUpdateCoordinator` serially downloads stale targets in the background
  and never hot-swaps a running ACP process. Its cancellation signal crosses native auth status,
  managed/registry download, and adapter startup; an aborted probe must not update the cache.
  Requests and responses carry that id so configs
  sharing a provider remain isolated. Real session creation also normalizes its `NewSessionResponse` through
  `acp-capability-normalization.ts`; the session execution service schedules a
  non-blocking cache update before the first prompt. Machine Flock writes ignore
  `fetchedAt` when comparing entries, so unchanged runtime capabilities do not
  commit or sync.
  Registry Cursor's per-model option catalog (`AcpCapabilityCacheEntry.configOptionsByModel`)
  comes only from an explicit `machine/acp-capabilities-refresh` probe calling
  `cursor/list_available_models` once after `session/new`; real sessions never fetch it.
  JSON-RPC `-32601` means no catalog; any other failure fails the probe with
  `[ACP_CAPABILITIES_INCOMPLETE]` so the settings test button can retry. Omitting
  `configOptionsByModel` on a Machine Flock write preserves the stored catalog for the
  same `sourceVersion`, and the unchanged-entry comparison includes it. Never enumerate
  models through `session/set_config_option`: it rewrites the user's global Cursor config.
  `resolveAcpConfigOptionsForModel` in `@lody/shared` is the one composition rule: an
  option owned by any model's catalog entry is per-model, and `model`/`mode` options
  always come from the snapshot.
- `login-shell-env.ts` — login-shell env capture for spawned agents.
- Builtin Claude owns session title generation through ACP
  `session_info_update`; `AgentClient` forwards those titles and `MessageHandler`
  stores them only after `sanitizeLodyInternalInstructions`. It must not start
  `title-generator.ts`'s isolated ACP session. Builtin Codex still uses the
  isolated generator, but its adapter tags every pushed title with
  `_meta.lody.titleSource`: accept only `explicit` thread names and ignore its
  first-prompt `fallback`. Codex title-agent chunks require
  `_meta.lody.messagePhase === 'final_answer'`; untyped chunks, provider error/warning
  payloads, and internal-instruction tails are not title candidates. Each isolated
  run owns and removes a unique temp directory, and concurrent session-title /
  branch-name work reuses one in-flight result. The shared
  `usesAcpProvidedSessionTitle()` predicate hides obsolete provider title
  settings only for Claude. Other providers use `title-generator.ts` /
  `response-utils.ts` for session titles.
