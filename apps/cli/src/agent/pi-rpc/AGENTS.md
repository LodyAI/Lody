# Native Pi RPC

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

- Pi owns execution and its native session file. Store that file as the provider
  session id; never replay Lody history into Pi or maintain a second session map.
- Keep Pi JSONL off the ACP wire. Adapt the existing host connection contract here;
  both session and probe/title startup must use `createAgentStream` and the shared start gate.
- A prompt acknowledgement is acceptance, not completion. Drain notifications before
  resolving a settled run; a handled input may acknowledge without starting a run.
- Advertise only implemented capabilities. Pi does not provide MCP or tool approval;
  extension questions are interactive input, never an approval policy.
- Serialize notifications but never block response parsing behind user interaction.
  Reject pending work on malformed transport or EOF; do not silently restart a prompt.

- A steer is applied only when Pi emits the custom message with the matching steer id.
  Hold later notifications behind the host ownership lease. Preserve a native idle
  refusal even when it arrives after settlement so the host can safely requeue.
- Keep the small steering extension bundled beside the CLI in both build layouts;
  initialization must verify its ready receipt before advertising steering.
