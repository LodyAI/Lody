# Native Pi RPC

Select **Pi (native RPC)** in Settings > Agents on an updated daemon. The daemon
advertises `nativePiRpc: 1`; an older daemon does not offer this new provider.
This entry runs the exact `@earendil-works/pi-coding-agent` release in `version.ts`
through npx, using Lody's existing isolated npm cache and startup recovery. It
requires npx and Node.js 22.19 or newer on the execution machine. It is not an
R2-managed runtime and does not automatically upgrade Pi.

Pi reads its own authentication and settings on that machine. Sign in using Pi's
terminal `/login`, or configure the provider's API-key environment variables in
Lody's agent settings. `PI_CODING_AGENT_DIR` can select an existing Pi home. No
credentials are copied into session metadata. Tools run with Pi's native access:
Pi has no tool approval or permission mode. Its extension questions use Lody's
existing interactive question UI; they are not a sandbox.

## Connection and ownership

```text
Session.createAgent / startLocalAcpAgent (probe and isolated title)
  -> existing start gate, process environment, spawn and startup monitor
  -> createAgentStream
       ACP agents: SDK connection, unchanged
       builtin Pi: PiRpcConnection -> PiTransport -> pi --mode rpc
  -> AgentClient.sessionUpdate -> existing history and code-collab pipeline
```

The host control surface still uses ACP types. The Pi implementation adapts that
surface in-process; it does not run an ACP server or send JSON-RPC to Pi. Pi owns
its execution, tools and session file. That native `.jsonl` file path is stored as
the provider session id. Resume uses `switch_session` and verifies the resulting
identity; it does not replay Lody history or create a second session map. Lody's
history remains the presentation/collaboration record. Concurrent editing of that
file from a terminal is not coordinated by this integration.

A successful `prompt` response means accepted or handled. Runs that start finish
on `agent_settled`, after queued notifications and usage have been applied; an
`agent_end` during retry is insufficient. For input hooks/extension commands that
handle input without a run, a post-ack state read plus drained events proves the
no-run path. Empty output still goes through Lody's existing silent-turn handling.
Failures after partial output remain failures. EOF and malformed frames reject
pending work. Cancel sends `clear_queue` before `abort`.

Pi's `tool_execution_*` events own execution status. Model `toolcall_*` deltas do
not imply execution. Tool arguments, outputs, paths and edit replacement pairs
are translated explicitly; Kimi's title-based enrichment is not their source.
Steer uses the bundled `pi-rpc-extension.js`, loaded inside Pi through `-e`. Its
internal `/lody-steer` command atomically refuses an idle session or queues a Pi
custom message with `details.steerId`. The host confirms application only on that
message's `message_start`, then waits for the existing ownership-transfer lease
before forwarding subsequent output. Text is never used as an identity. Startup
and refusal receipts use Pi's native UI notification channel with a reserved
`lody-rpc:` prefix; they are consumed by the connection, not shown as chat.
No separate process or scheduler is introduced. Model/config changes remain
active-turn constrained; ordinary queued turns continue through Lody.
Before Pi starts a run, steering is refused so Lody retains the ordinary queued input.

Only events during the active invocation enter chat history. Out-of-turn Pi
extension output is not imported as a new Lody turn.

## Current scope

- Text, thinking, image inputs and tool results; file/resource text and links.
- Live model selection and the selected model's thinking ladder, including startup
  configuration. Model catalogs come from Pi, not a hardcoded provider list.
- Normal multi-turn use, cancellation, failures, and restart/resume of Lody-created
  native Pi sessions. Existing registry `pi-acp` configs keep their adapter and ids;
  this entry is an explicit opt-in, not a migration of their sessions.
- Isolated title generation uses the same connection. Its Pi session files live
  under the title temporary directory and are removed with that directory.
- `/compact` and `/stats`; Pi's automatic compaction remains enabled by its settings.
  Context usage follows provider measurements and the settled Pi context estimate.
  Pi may report an unknown context estimate immediately after compaction; the host
  retains its last measurement until the next valid one.
- Cumulative token/cost snapshots come from Pi's `get_session_stats`, including
  native resume and compaction. `/stats` exposes them locally. The existing hosted
  usage/billing consumer only accepts managed agents and is not extended here.
- Extension select/confirm/input/editor requests use the existing question flow.
  Editor prefill is shown as context for a free-text answer. Requests outside a
  prompt are cancelled; late answers cannot change a subsequent turn.

Native-session import/discovery, fork, workspace MCP, Pi TUI
widgets/status/editor replacement, in-app OAuth and managed-runtime updates are
not advertised. Ordinary Lody queued turns still work. Selecting workspace MCP
servers fails explicitly before session establishment rather than ignoring them.
`/compact` and `/stats` are host-handled commands; other input is passed to Pi.

## Verification

The deterministic tests use synthetic JSONL, explicit signals and no model/network
requests. They cover framing, command correlation, startup/config, completion,
retry, cancellation, EOF, native resume, tool evidence, usage and extension input.

For an explicit real-runtime smoke from the repository root:

```sh
pnpm --filter lody prepare:acp-adapters
pnpm --filter lody dev:build
pnpm --filter lody exec tsx scripts/smoke-pi-rpc.ts
```

This downloads the pinned package into a temporary npm cache, then uses a synthetic
in-process Pi provider without model network requests or user credentials. It runs
through the real launch resolver and `AgentClient`, writes a temporary file with
Pi's actual `write` tool, handles input and a cancelled dialog, reads stats, steers a gated tool execution
and verifies that output waits for the ownership lease, kills
and restarts Pi, and resumes the same session. Synthetic artifacts are retained in
the printed temporary directory. This synthetic script does not validate a commercial provider, Electron interaction,
or Windows packaging. A separate local live-provider check verified DeepSeek V4 Flash
tool execution, steering, compaction, stats, native resume and isolated title generation.
Compaction used an isolated Pi profile with a smaller recent-context retention threshold;
provider credentials and the normal Pi profile were not modified.
An isolated Electron acceptance run also verified provider setup, model/thinking
selection, a local project, steering that changed the actual file result, stats,
cancellation of a running tool and continuation after renderer reload/reconnection.
Windows packaging and other commercial providers remain unverified.

Protocol evidence: Pi
[`rpc-mode.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/modes/rpc/rpc-mode.ts),
[`agent-session.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts), and
[`docs/rpc.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md).
