# apps/cli/src/agent

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

ACP client side of the CLI. File map: [README.md](README.md).
Protocol: context/acp-protocol.md; edit-payload quirks:
context/acp-agent-edit-evidence.md; adapter repos: [apps/cli/AGENTS.md](../../AGENTS.md).

## `agent-client.ts`

- Consume Core extensions via `agentCapabilities._meta.lody`, session `_meta.lody`, and
  `_lody/...`. Provider/pre-Core readers stay in `lody-acp-extension.ts`; consumers stay neutral.
- Grok Always Approve uses `allow_once`, never lasting grants; pending calls drain through
  the durable permission flow on accepted config changes. Questions remain interactive.
- Builtin Grok must default `clientCapabilities.terminal` to false.
- ACP file reads map native `ENOENT` to `RequestError.resourceNotFound`; preserve
  other failures and session validation rather than returning empty content.
- Send the driving turn's model/config on session establishment as `_meta.lody.sessionConfig`;
  provider-specific startup translation belongs in the ACP adapter. `session/set_config_option`
  stays the live-session switch, and a successful selection becomes a later replacement's
  startup state.
- Cache session `_meta.lody.modelReasoningEfforts`; Codex `model[effort]` only.
- Project config from setup, `set_config_option` responses, and `config_option_update`.
  Present `configOptions` (including `[]`) replaces the snapshot; only omission falls back
  to the requested value, updating both replacement startup state and `currentValue`.
- Convert Core `_meta.lody.goal` epoch seconds to durable milliseconds here, and normalize
  `limited` to the durable `blocked` status.
- Keep both built-in `lody` MCP transports. INVARIANT: MCP tools must not run inside the
  daemon process.
- MCP HTTP: loopback bind plus bearer token; on Linux prove the peer socket's uid via
  `/proc/net/tcp{,6}`, REJECT an unprovable peer, and refuse to start when it is
  unreadable. `LODY_MCP_HTTP_DISABLED=1` forces stdio. Stdio uses an explicit env allowlist: keep `LODY_AUTH_URL`, `LODY_AUTH_SITE_URL`, and
  `LODY_SERVER_URL` so cloud MCP orchestration uses the daemon's deployment, let local platform
  assembly clear them before agent startup, and never add CLI credentials or secrets.
- Pass the same MCP config on initial and replacement DeepSeek Harness sessions.
- Workspace MCP resolution starts before `initialize` to overlap the handshake.
  Before the first remote baseline, complete selected rows may start locally with a
  config warning. Missing selected rows preserve the typed cold error and may reload
  once before provider-session establishment; still missing fails initialization.
  Check completeness before preparing local authentication so a recheck cannot repeat it.
- Acknowledged steer ends `applied`, `not-applied`, or `unknown`. Only adapter proof maps
  `not-applied`; transport/process ambiguity stays `unknown`. Await the request answer even
  after the turn response; Session execution never classifies provider errors.

## Launch and runtimes

- `acp-runner.ts`: spawn + initialize + `newSession`/`loadSession` go through
  `acp-session-start-gate.ts` (default 2, `LODY_MAX_CONCURRENT_ACP_SESSION_STARTS`). Never bypass
  that gate.
- Builtins use `setting.ts`'s `resolveACPProcessLaunchAsync()`. [Codex profiles](../../../../specs/codex-account-profiles.md)
  forbid upstream keys in shared/child env. Process records delay deletion, never
  restrict same-profile concurrency.
- `deepseek-harness-runtime.ts` is not managed: no download/prefetch/override/auth.
  Keep npx argv for recovery. Windows uses npm JS without cmd.exe;
  npm, forwarder, DSH and Job children stay windowless, preserving stdio/env/containment.
  DSH pins Node checked in child cwd; no Electron fallback.
  Provider ID isolates homes; preserve user YAML/settings and legacy history:
  [contract](../../../../specs/deepseek-harness-settings.md).
  Credentials stay in env. Models/reasoning use the Agent request waterfall;
  permissions use Harness presets. `agent_preset` uses `AgentPresets.mount/recompose`
  only before the first prompt. Per-Agent ACP stdio/HTTP MCP belongs in the adapter.
  Never modify JSONL; mixed roots fail naming both paths.
- `managed-agent-runtime.ts`: native pins live only in `<name>-runtime-manifest.json`.
  Reject version mismatches and unknown legacy fields; do not duplicate pins or weaken the schema.
  Read Claude metadata from the adapter's installed SDK; the CLI dev SDK may differ.
  Definition drift is a miss; cleanup and update scans are best effort. Grok/Devin submodules never build official runtime binaries, and the desktop must not depend on the Kimi submodule workspace. Custom
  methods stay capability-gated. Inject the artifact base URL from
  `CloudPort.runtimeArtifacts`; never read deployment environment or derive the channel here.
  `LODY_RUNTIME_BASE_URL` is an explicit mirror override only.
- Install cancellation, here and in `acp-binary-manager.ts`: concurrent installs share one
  download but keep independent consumer leases; cancelling one caller must not stop others, and
  only the last aborts fetch, checksum, and extraction. An immediate retry waits for an aborted
  generation's scratch cleanup and never reuses it meanwhile. Tar and ZIP extraction must attach
  to the shared abort signal; ZIP cancellation destroys the yauzl endpoint, awaits the
  relay/output pipeline, and fences cleanup on the reader's real close/error event — never await
  the yauzl endpoint, whose `destroy()` does not settle.
- Builtin Dimcode is user-installed.
- `npx-cache.ts`: ACP `npx` spawns force `npm_config_cache`/`NPM_CONFIG_CACHE` to the active
  profile's `npm-cache`. Automatic `_npx`/`_cacache` cleanup is allowed ONLY for that Lody-owned
  cache.

## `acp-authentication.ts`

- The per-agent slot covers preparation and the child; cancel/timeout wins through cleanup,
  terminates the process, and releases Retry. Stop the process before success.
- Authorization data must never enter logs, chat, Flock, or config; raw provider output and
  secret defaults must never reach retained progress.
- Claude capability refresh runs its native status command first so missing credentials surface
  as structured auth-required state before adapter startup; explicit environment-authenticated
  paths bypass it.
- Registry/custom/Devin advertises no terminal capability; only agent-driven methods run.
  Reject deprecated `env_var`; `terminal` needs a real Machine RPC interactive bridge.
  Keep method lists/elicitations on the original request, one pending interaction at a time.
  Replies carry interaction ids and use encrypted remote authentication-input. Bound URL schemes, sizes,
  ids, labels, options, and defaults before they enter progress, under a shared serialized-byte
  budget for the form.
- Machine RPC may name only a persisted Provider `configId`; the daemon freezes
  machine/CLI/agent/launch/env/runtime fields before spawning, capability refresh included, and
  later replies can never replace that launch target.

## Capabilities and titles

- Static capabilities: builtins without overrides only. Refresh probes the runtime,
  cached by `agentConfigId` + launched version; requests/responses carry that id. Aborted
  probes never update cache. Updates never hot-swap ACP; Flock ignores `fetchedAt`.
- Capability probes own unique temporary workdirs, never inherited cwd/projects. Remove
  after shutdown even on failure/cancellation; removal errors never replace probe
  outcomes. Keep provider homes unchanged.
- Core `sessionTitle` v1 owns titles after init except builtin Codex.
  Lody owns Codex titles/settings; never the adapter. Accept `generated`/`explicit`,
  not `fallback`/`unset`. Untagged titles: only legacy managed Claude/Grok without overrides.
  Strip internal instructions; keep user titles.
  Isolated titles: accept absent phases; prefer final answers; discard commentary/pre-prompt
  text; sanitize. [Rules](README.md#session-titles).
- NEVER derive a git ref from prompt text: refs reach the remote and no filter proves a
  prompt secret-free. Worktree sessions keep their allocated ref unless the agent renames it.

## Shell

LoginShellCache lives in the app root. Legacy binds it; no Promise cache/timer.
Reader cancellation preserves siblings. Await disposal; replace only after release.
[Decision](README.md#login-shell-cache).
