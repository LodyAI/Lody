# apps/cli/src/agent

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

CLI ACP client. Index/background: [README.md](README.md).
Protocol: context/acp-protocol.md; edit-payload quirks:
context/acp-agent-edit-evidence.md; adapter repos: [apps/cli/AGENTS.md](../../AGENTS.md).

## `agent-client.ts`

- Consume ACP extensions through `acp-extension-core` (`agentCapabilities._meta.lody`, session
  `_meta.lody`, `_lody/...` methods). Provider-specific and pre-Core readers stay in the central
  compatibility adapter, never in session consumers; normalized Core capabilities stay
  provider-neutral.
- Builtin Grok must default `clientCapabilities.terminal` to false.
- Send the driving turn's config on every session establishment as `_meta.lody.sessionConfig`;
  provider startup translation belongs in the adapter. `session/set_config_option`
  switches live sessions; successful selection becomes replacement
  startup state.
- Config projections consume confirmed session setup and
  `set_config_option` responses, not just `config_option_update` notifications. A
  present `configOptions` — empty array included — is the full snapshot; only an
  omitted field falls back to the requested value, and that fallback updates both replacement
  startup state and the option's `currentValue`.
- Convert Core `_meta.lody.goal` epoch seconds to durable milliseconds; normalize
  `limited` to the durable `blocked` status.
- Keep both built-in `lody` MCP transports; tools never run in the
  daemon process.
- MCP HTTP: loopback bind plus bearer token; on Linux prove the peer socket's uid via
  `/proc/net/tcp{,6}`, REJECT an unprovable peer, and refuse to start when it is
  unreadable. `LODY_MCP_HTTP_DISABLED=1` forces stdio. The stdio config is an explicit env
  allowlist, never inheritance: keep `LODY_AUTH_URL`, `LODY_AUTH_SITE_URL`, and
  `LODY_SERVER_URL` so cloud MCP orchestration uses the daemon's deployment, let local platform
  assembly clear them before agent startup, and never add CLI credentials or secrets.
- Pass the same MCP config on initial and replacement DeepSeek Harness sessions, and preserve
  the driving Turn's `taskToolsEnabled` bit (HTTP header or stdio allowlisted env) across
  replacement and restored sessions; missing/false keeps the server mounted but drops every
  `lody_task_*` tool.
- Workspace MCP resolution stays TWO phases: call `loadExternalMcpServers` BEFORE `initialize`,
  never between `initialize` and `newSession`.
- Acknowledged steer is inject-or-refuse. `AgentSteerNotDeliveredError` marks ONLY a provable
  refusal — local pre-write failure or the agent's own JSON-RPC `invalid request`; never widen
  it. Applied-waiter awaits the steer answer before abandoning the turn
  response.

## Launch and runtimes

- `acp-runner.ts`: spawn + initialize + `newSession`/`loadSession` go through
  `acp-session-start-gate.ts` (default 2, `LODY_MAX_CONCURRENT_ACP_SESSION_STARTS`). Never bypass
  that gate.
- `setting.ts`: every builtin requires `resolveACPProcessLaunchAsync()`.
- `account-profiles.ts`: resolve local ids after env merge; missing ids keep native System Default.
  Codex/Claude auth/status/title share each isolated profile home; never copy credentials or fall back
  on missing ids. Strip inherited Claude credential-store/auth overrides only for managed profiles.
- `deepseek-harness-runtime.ts` is NOT a managed runtime: keep it out of runtime download,
  prefetch, override, and interactive-auth flows, and launch the pinned closure, not the
  all-in-one `@deepseek-ai/dsh` CLI. Credentials stay in the agent config environment;
  never write them into the generated config. The adapter applies model/reasoning selection
  through the Agent-scoped request waterfall, permissions through Harness presets,
  and `agent_preset` through `AgentPresets.mount/recompose` — never as UI-only state. Presets
  may change only before the first prompt. Per-Agent ACP stdio/HTTP MCP servers belong in the
  extension adapter, not the immutable host composition. JSONL encoding detection is READ-ONLY:
  fail a mixed root naming both paths; never migrate, rename, or delete session artifacts.
- `managed-agent-runtime.ts`: Codex pins come only from `codex-runtime-manifest.json`, Claude
  pins only from `claude-runtime-manifest.json`; reject a dependency/manifest version mismatch
  and never duplicate pins/checksums beside the manager. Do not loosen the metadata
  schema or accept unknown legacy fields. Never source production
  Grok binaries from its submodule; desktop must not depend on the Kimi submodule. Custom
  methods stay capability-gated. Inject the artifact base URL from
  `CloudPort.runtimeArtifacts`; never read deployment environment or derive the channel here.
  `LODY_RUNTIME_BASE_URL` is an explicit mirror override only.
- Install cancellation, here and in `acp-binary-manager.ts`: concurrent installs share one
  download but keep independent consumer leases; cancelling one caller must not stop others, and
  only the last aborts fetch, checksum, and extraction. Immediate retry waits for an aborted
  generation's scratch cleanup and never reuses it meanwhile. Tar and ZIP extraction must attach
  to the shared abort signal; ZIP cancellation destroys the yauzl endpoint, awaits the
  relay/output pipeline, and fences cleanup on the reader's real close/error event — never await
  the yauzl endpoint, whose `destroy()` does not settle.
- `npx-cache.ts`: ACP `npx` spawns force `npm_config_cache`/`NPM_CONFIG_CACHE` to the active
  profile's `npm-cache`. Automatic `_npx`/`_cacache` cleanup is allowed ONLY for that Lody-owned
  cache.

## `acp-authentication.ts`

- One provider/account slot covers launch preparation and the child process;
  timeout/cancel terminate it and release it for Retry, and a cancel or timeout during cleanup
  still wins. Stop before returning success.
- Authorization data must never enter logs, chat, Flock, or config; raw provider output and
  secret defaults must never reach retained progress.
- Claude capability refresh runs its native status command first so missing credentials surface
  as structured auth-required state before adapter startup; explicit environment-authenticated
  paths bypass it.
- Registry/custom initialization advertises no terminal capability; only agent-driven methods
  are runnable (`env_var` rejected as deprecated, `terminal` unsupported until Machine RPC has a
  real interactive-terminal bridge). Method lists and elicitations stay on the original
  long-running request with one pending interaction at a time; replies carry an interaction id
  and use the encrypted authentication-input path on remote Machines. Bound URL schemes, sizes,
  ids, labels, options, and defaults before progress, under a shared serialized-byte
  budget for the form.
- Machine RPC may name only a persisted Provider `configId`; the daemon freezes
  machine/CLI/agent/launch/env/runtime fields before spawning, capability refresh included, and
  later replies can never replace that launch target.

## Capabilities and titles

- `getStaticBuiltinAcpCapabilities()` applies only to `cliType: 'builtin'` without runtime
  overrides. `machine/acp-capabilities-refresh` is always a real runtime probe, cached per
  `agentConfigId` and the launched runtime version; an aborted probe must NOT update
  the cache, and requests/responses carry that id to keep configs of one provider isolated.
  `ManagedRuntimeUpdateCoordinator` never hot-swaps a running ACP process, and Machine Flock
  writes ignore `fetchedAt` when comparing entries.
- Builtin Claude owns session titles through ACP `session_info_update`; store them only after
  `sanitizeLodyInternalInstructions`, and never start `title-generator.ts`'s isolated session
  for Claude. For Codex accept only `explicit` `_meta.lody.titleSource` names, ignore its
  first-prompt `fallback`, and require `_meta.lody.messagePhase === 'final_answer'`; untyped
  chunks, error/warning payloads, and internal-instruction tails are never candidates.
  Each isolated run owns and removes a unique temp directory; concurrent session-title and
  branch-name work reuses one in-flight result.
