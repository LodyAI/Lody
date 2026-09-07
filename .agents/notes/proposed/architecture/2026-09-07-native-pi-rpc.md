# Native Pi at the existing host connection boundary

Status: proposed
Translation: pending

## Abstract

[Issue #451](https://github.com/LodyAI/Lody/issues/451) proposes replacing the
third-party Pi ACP bridge with direct Pi RPC. This implementation adds an opt-in
builtin provider whose in-process connection implements Lody's existing host
control contract while speaking Pi JSONL on the wire. It reuses session ownership,
startup gates, history and interactive questions, and keeps Pi's native file as
execution/resume authority. Maintainer acceptance is pending; this is a working
proposal, not a claim of full Pi parity or an adopted protocol strategy.

## Boundary and alternatives

A second session executor or scheduler would duplicate turn ownership. Instead,
`AgentClient` accepts the existing SDK connection or the Pi connection; both
normal sessions and probe/title launches select that connection from the same
stream factory. Unsupported host methods reject explicitly and are not advertised.

A Lody-owned ACP adapter is also viable. ACP does not inherently require a second
session-id map, nor does it inherently lose every Pi capability. That alternative
would preserve an ACP-only wire boundary but introduce another executable and
its packaging. Direct RPC trades that packaging for a Pi-specific implementation
inside the CLI. This proposal deliberately limits the new host surface to that
connection, rather than generalizing the whole agent execution stack.

## Evidence that shaped the implementation

- Pi's prompt acknowledgement also covers extension/input-hook handling without an
  agent run. Waiting only for `agent_settled` would hang that supported path.
- `agent_end` can precede retry or queue continuation. Started runs need the later
  settled event, and cancellation must clear the queue before aborting.
- Model `toolcall_*` deltas describe generation; `tool_execution_*` describes
  execution. Tool evidence is translated from args/results, not guessed from titles.
- Usage deltas are cumulative per message, while Lody's usage channel expects a
  session snapshot. Pi's `get_session_stats` already owns that aggregate, including
  compaction and native resume, so no second usage ledger is introduced.
- Native resume and importing terminal history are distinct. This change resumes
  the stored native file without replaying or merging another history into Lody.

These conclusions were checked against the pinned Pi release's source and a real
Pi process driven by a synthetic offline provider. The
[connection README](../../../../apps/cli/src/agent/pi-rpc/README.md) links upstream
source, documents supported behavior and gives the reproducible smoke command.

## Limits and review decision

The first PR includes ordinary turns, acknowledged steer and native restart/resume.
Pi's queue acknowledgement alone does not prove application. A small bundled Pi
extension preserves the steer id in native custom-message metadata; message_start
then drives Lody's existing ownership handoff. This avoids matching by text or adding
a second execution authority. It omits terminal-history
import, MCP, managed-runtime distribution and TUI widgets. Existing `pi-acp`
configurations are not migrated. The offline smoke is complemented by a local DeepSeek V4 Flash check for tool
execution, steer, compaction, statistics, resume and isolated title generation.
An isolated Electron run also verified provider/model setup, actual file-changing
steer, statistics, tool cancellation and continuation after reconnection.
Windows packaging and other commercial providers remain unverified.

The maintainer decision is whether this bounded native connection is an acceptable
long-term integration boundary. Changing that decision to an owned ACP executable
would retain much of the translation and lifecycle evidence; neither choice is
asserted to be universally better.
