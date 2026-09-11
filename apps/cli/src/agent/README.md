# apps/cli/src/agent

ACP client side of the CLI: spawning coding agents, talking the Agent Client Protocol to
them, resolving their runtimes, and authenticating them. Binding rules for this directory
live in [AGENTS.md](AGENTS.md); this file is the responsibility index and the background a
reader needs to place a change.

Protocol reference: context/acp-protocol.md. Per-agent edit-payload quirks:
context/acp-agent-edit-evidence.md. Adapter source repositories and builtin provenance:
[apps/cli/AGENTS.md](../../AGENTS.md). Where updates go after they arrive:
context/message-flow.md "Upstream".

## Files

- `agent-client.ts` — the ACP connection: initialize/session lifecycle, client
  capabilities (fs, elicitation), permission/fs request handling, update callbacks. Lody
  ACP extensions are consumed through `acp-extension-core`, so capability discovery lives
  at `agentCapabilities._meta.lody`, session metadata at `_meta.lody`, and custom methods
  use the Core `_lody/...` names.
- `acp-runner.ts` — process spawn/restart around the client. Spawn + initialize +
  `newSession`/`loadSession` share `acp-session-start-gate.ts`.
- `acp-session-start-gate.ts` — process-wide start semaphore used by
  `Session.createAgent`, `startLocalAcpAgent`, and history-catalog ACP spawn.
- `setting.ts` — launch resolution for every agent kind.
- `deepseek-harness-runtime.ts` — Harness-home (`DSH_HOME`, then `~/.dsh`), atomic-config,
  and npx launch wrapper around the `packages/acp-extension-dsh` submodule.
- `managed-agent-runtime.ts` — pinned Codex/Claude Code/Grok native and Kimi Node-package
  `.tar.zst` artifacts, checksums, resumable downloads, the active installation profile's
  `agent-binaries` layout, and best-effort `bin` symlinks for complete native CLIs.
- `acp-authentication.ts` / `acp-authentication-output.ts` — the authentication lifecycle
  and the incremental conversion of bounded provider output into allowlisted authorization
  URLs, device codes, expiry, and Claude's optional browser-returned code input.
- `acp-binary-manager.ts` — registry binary-distribution agents (tar/zip install).
- `npx-cache.ts` — npx cache isolation plus poisoning detection/purge for resilient
  registry launches.
- `acp-capabilities.ts` / `acp-startup-monitor.ts` / `acp-analytics.ts` — capability cache,
  startup health, analytics.
- `login-shell-env.ts` — login-shell env capture for spawned agents.
- `fixtures/` — synthetic test fixtures.

## Background

### Grok permission handling

Grok's TUI combines the runtime YOLO setting with client-side `AllowOnce` responses.
`lody-acp-extension.ts` owns this compatibility rule for builtin Grok only;
`agent-client.ts` evaluates it against the accepted session config and exposes config
subscriptions. `MessageHandler` persists the selected outcome in the existing permission
history. Enabling Always Approve also drains already waiting requests and clears their UI
state and subscriptions. New requests without `allow_once` stay interactive; the queue
drain cancels such requests, matching the TUI without creating lasting grants. User
questions and other providers do not participate. The Grok adapter passes native requests
through so this durable flow remains their single owner.

### ACP start concurrency

Unbounded concurrent Codex starts each spawn a lody.exe adapter, a Codex app-server, and a
lody.exe MCP child; they contend on `~/.codex` and freeze every in-flight session until
Lody restarts. Hence the shared start gate (default 2,
`LODY_MAX_CONCURRENT_ACP_SESSION_STARTS`).

### The built-in `lody` MCP server has two transports

Agents whose initialize response advertises `mcpCapabilities.http` get a shared HTTP
endpoint served by ONE host subprocess per daemon (`src/mcp/lody-mcp-http-host.ts`,
supervised by `src/mcp/lody-mcp-http-server.ts`); everything else keeps the per-session
stdio entry. The supervisor keeps token and port stable across host restarts because
sessions bake the endpoint into their MCP config at creation; while the host is down, new
sessions silently fall back to stdio.

MCP tools do synchronous SQLite work (`orchestration/operation-store.ts` restricts that to
subprocess boundaries) and one-shot workspace-manager work, either of which would stall the
daemon event loop — which is why they never run inside the daemon process.

On Linux the HTTP host proves the peer socket's uid via `/proc/net/tcp{,6}` because the
bearer token leaks through the agent runtime's `/proc` cmdline there, so failing open would
void it.

Builtin DeepSeek Harness mounts the stdio server per ACP session through the extension's
native `dsh-mcp-client` bridge; the bridge owns namespace collision handling and releases
the MCP child with `session/close` or Agent teardown.

### Workspace MCP resolution is two phases

`loadExternalMcpServers` (catalog sync + document read) runs BEFORE `initialize` so its
remote round trip overlaps spawn and the handshake, and the selector it resolves to applies
the agent's advertised `http` capability at `newSession`. Awaiting the load between
`initialize` and `newSession` would put a remote sync — up to its 5s budget — on the
critical path of every session establishment while the agent process sits idle.

### Steer delivery classification

The applied-waiter must wait for the steer request's own answer before giving up on the
upstream turn's response: the Codex adapter drains session notifications before refusing,
so the turn's response routinely wins that race and would otherwise mask the refusal. A
closed connection, a dead agent process, or an internal error may have left the prompt
inside the live turn, and the caller re-sends an undelivered steer — so widening the
"not delivered" classification sends the user's message twice.

### DeepSeek Harness is not a managed runtime

`deepseek-harness-runtime.ts` publishes Lody's versioned ACP composition beside (without
replacing) user Harness config and launches the pinned explicit package closure through
`dsh-acp-demo`. The all-in-one `@deepseek-ai/dsh` product CLI is deliberately not used
because this ACP host excludes product UI and telemetry packages. CLI production and dev
builds copy the extension's pinned official presets beside `deepseek-acp.js`; the generated
roster also discovers `$DSH_HOME/.agent-presets`. The host mounts Harness's file settings
provider for `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`); refresh provider
capabilities after editing the model catalog. An explicit `DEEPSEEK_BASE_URL` still uses
the endpoint's `/models` list rather than local catalog additions. Harness JSONL roots are single-encoding
stores: an empty or zstd root uses upstream's `zstd`, a raw-only legacy root keeps `none`,
and a mixed root fails with both paths named.

### Managed runtimes

Codex version/archive pins come from `codex-runtime-manifest.json`, which the outer
`mirror:agent-runtimes` operator command atomically refreshes from the exact official GitHub
Release when the adapter's `@openai/codex` dependency changes. Claude SDK/runtime archive
pins come from `claude-runtime-manifest.json`; the mirror derives sources and integrity from
the adapter lockfile, regenerates all eight zstd archives after a version change, verifies
the canonical production objects, and then atomically updates the manifest.

Grok launches the pinned `acp-extension-grok` compatibility adapter with an official,
unmodified R2-managed runtime in `GROK_PATH`; the submodule owns the private-wire contract
and minimum official version. Kimi is different: `packages/acp-extension-kimi` owns the
Lody-maintained runtime source and implements the shared `acp-extension-core` contract.

Completed caches written before metadata schema v1 remain reusable through a separate strict
legacy schema; their old `name`/`version`/`platform` fields are normalized in memory and only
the trusted runtime definition's command and host requirement are inferred. Repacked Node
packages intentionally publish no convenience link because non-ACP subcommands may be
omitted. A fully validated install that has already crossed the final complete-marker commit
may remain a safe cache hit even though that caller observes cancellation, and network
failures retain the URL plus nested transport cause for diagnostics.

### Authentication

Which authentication path runs is decided by the provider, not the caller: a managed builtin
runs its pinned login command, and everything else (registry and custom ACP) opens a
temporary standard ACP connection in the same bounded lifecycle. Kimi runs `acp --login`;
Grok runs the official `login --device-auth`; Claude Code runs the official
`auth login --claudeai` subscription flow. Codex normally runs the official
`login --device-auth` ChatGPT flow. A Codex provider configured with Base URL + API Key
receives a custom `model_providers` entry through `CODEX_CONFIG` and sets
`requires_openai_auth = false`. Its key arrives through encrypted authentication input, stays
in the target machine's owner-only provider credential store, and is injected only while the
SHA-256 digest of its canonical launch binding matches. The raw binding and its environment are
not copied into the credential file.

Remote Web transport stores only an ephemeral-ECDH/AES-GCM envelope in the 24-hour request
stream; the target machine keeps the recipient private key in memory and decrypts
immediately before stdin. Local UI and CLI state is in memory. Raw output progress remains
only as a temporary old-renderer compatibility field.

Grok and Codex authentication requirements come from ACP session creation because
`codex login status` cannot account for custom model providers with
`requires_openai_auth = false`. Because protocol authentication spans launch preparation,
JSON-RPC requests, and process cleanup, the running slot also carries an `AbortController`
that termination raises before any child exists. Custom Codex provisioning keeps that same slot
through setup synchronization, live probe, credential staging, and final publication. Cancel wins
until the synchronous Flock commit boundary; after it the publication wins, and a flush failure is
reported as uncertain durability rather than a cancelled or ordinary failed save.

The real-process authentication test keeps method selection, versioned secret metadata, form
submission, URL parsing, protocol stdout integrity, and process cleanup on one spawned ACP
connection.

### Capability cache

Default managed builtin Codex/Claude/Kimi/Grok capabilities come from
`getStaticBuiltinAcpCapabilities()` in `@lody/shared` so onboarding, settings, and chat can
render mode/model/config options without spawning adapters or downloading managed runtimes.
DeepSeek's static entry mirrors the bundled adapter's model, reasoning-effort, and permission
selectors. Registry/custom agents and builtin runtime overrides still need the actual ACP
agent.

`machine/acp-capabilities-refresh` resolves the pinned target, then the most recently
installed reusable runtime, and blocks on `ensureCurrentRuntime()` only when no runtime is
installed. `ManagedRuntimeUpdateCoordinator` serially downloads stale targets in the
background and never hot-swaps a running ACP process. Real session creation also normalizes
its `NewSessionResponse` through `acp-capability-normalization.ts`; the session execution
service schedules a non-blocking cache update before the first prompt. Adapters may publish
per-model reasoning-effort ladders on that session response as
`_meta.lody.modelReasoningEfforts`. Normalization merges the map into the cached
`modelReasoningEfforts`, together with the legacy `model[effort]` id derivation for builtin
Codex only — other agents use the same brackets for unrelated variants (Claude's `opus[1m]`
is a context window). Vendor model `_meta` never enters the CLI.

Capability cache versions are freshness markers, not read barriers. A newer client continues
to render understood fields from an older daemon's parsed entry while scheduling a replacement
probe; likewise, an older client may use the understood portion of a newer entry. Runtime
override entries still apply only when their source-version suffix matches the selected override.

### Session titles

Builtin Claude, Codex and Grok own session title generation through ACP
`session_info_update`; Kimi and the DeepSeek Harness still use `title-generator.ts` /
`response-utils.ts` and the `titleGeneration` config. `BUILTIN_ACP_TITLE_OWNERSHIP` in
`packages/shared/src/ai.ts` is the single table behind both facts, and its doc comment
carries the per-adapter mechanism; the audit evidence and what each remaining gap would
cost to close live in the [decision note](../../../../.agents/notes/implemented/architecture/2026-09-08-acp-owned-session-titles.md).

Two predicates read that table, and the difference between them is the part worth knowing.
`acpOwnsSessionTitleGeneration()` keeps the isolated session out of an agent's title path
and hides its obsolete title settings. `trustsUntaggedAcpSessionTitle()` is narrower: it
answers whether a pushed title may be stored without a `_meta.lody.titleSource` tag, which
is true only for the adapters that send no tag at all. Codex owns its generation but tags
every title and previews the raw first prompt as `fallback`, so trusting it untagged would
make that preview the session title.

A runtime override revokes ownership. `BuiltinRuntimeOverrides` can aim the same
`agentType` at an executable predating the title behaviour, and that session would otherwise
get no title at all — generator skipped, nothing pushed, and the setting that would fix it
hidden — so an overridden runtime keeps the local generator.

The daemon does not name branches. A worktree session stays on the `session/<id>` branch
`worktree-manager.ts` created for it, and `syncSessionBranchName` records whatever branch the
session is actually on after every turn, so an agent that renames the branch itself is picked
up. For GitHub projects the agent is asked to do exactly that — see
`GITHUB_WORKTREE_SYSTEM_COMMANDS` in `session/session-execution-helpers.ts`.

This used to be an automatic prompt-to-branch rename, removed because it could not be made
safe. A branch name is a ref: it reaches the remote as soon as the session opens a PR, so
deriving one from prompt text publishes prompt text, and "rotate the password before Friday"
is an ordinary request. Two filters were tried and both failed for the same reason — a secret
has no reliable shape, since `hunter2` is a password and an ordinary word. Stripping
credential-shaped tokens left everything that did not look like one; failing closed on
credential *syntax* still let plain prose through, so it fails open on every miss and cannot
be a security boundary. Naming refs after user text needs a source provably isolated from the
prompt, and no such source exists at session-ready: the ACP title has not arrived yet, and the
isolated generator's own fallback is the raw prompt.

### Local project identity

For local project sessions, `SessionManager` supplies a resolver for the original
root in the local project catalog. `Session` and `createAcpClient` carry it to
`AgentClient`, which invokes it only after the adapter advertises Core
`worktreeProject` version 1 and the final execution directory has been claimed.
The resolved metadata accompanies new/load/resume/fork and replacement sessions;
ACP cwd remains the actual worktree. This also covers local child sessions,
whose execution directory comes from their parent but whose project identity
comes from the local project record. GitHub-only and projectless sessions do not
send a local project identity. See the [draft contract](../../../../specs/local-project-acp-identity.zh.md).
