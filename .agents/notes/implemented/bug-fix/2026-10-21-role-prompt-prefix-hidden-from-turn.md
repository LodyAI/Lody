# Role Prompt prefix stays out of the visible user turn

Status: implemented
Translation: current

[中文](2026-10-21-role-prompt-prefix-hidden-from-turn.zh.md)

## Abstract

Sessions created with an Agent Role through Lody MCP or `lody session create
--agent-role` showed the Role's Prompt prefix inside the first user bubble and
derived title, because both resolvers composed `prefix + prompt` before the
visible turn was built. Role resolution now returns the authored prompt only;
the trimmed prefix travels separately in `CreateOptions.agentRolePromptPrefix`
and is composed solely into the turn's execution prompt (`inputConfig.prompt`),
matching the desktop composer. The MCP canonical command records the prefix as
its own field so acceptance still freezes it for retries and recovery. Turns
created before this change keep the prefix in their stored history.

## Decision and evidence

Root cause: `resolveAgentRoleCreate` and `resolveMcpSessionCreate` returned
`composeAgentRolePrompt(role.promptPrefix, prompt)`, and `prepareSessionInput`
built the visible items from that text. The [shared contract](../../../../packages/shared/AGENTS.md)
lets the execution text differ from visible items, and the desktop path already
keeps visible items raw.

The prefix is bound in `bindAgentRoleCreateOptions`, which the CLI, MCP single
create and MCP batch materialization all call, so one point covers every path.
`buildResolvedMcpCreateCanonicalCommand` adds `agentRolePromptPrefix`, keeping
the [freeze-at-acceptance rule](../../../../apps/cli/src/mcp/AGENTS.md) and
fingerprinting it. Daemon recovery in `message-handler.ts` restores the field
when present; Operations accepted earlier stored a composed `prompt` without
the field and replay unchanged.

Rejected alternative: stripping a known prefix from the visible text after
composition. It depends on string matching and breaks once the Role is edited.

## Verification

The fallback create suite now asserts the persisted turn shows `Continue` while
`inputConfig.prompt` is `Review carefully.\n\nContinue`; resolver suites assert
the raw prompt, the bound prefix, CLI/MCP parity and the canonical command
field. Role, MCP, session command and message-handler suites pass (474 tests).
Typecheck reports no errors outside uninitialized optional extension
submodules.

Limits: no live desktop end-to-end run; a newer MCP server whose Operation is
recovered by an older daemon would drop the prefix (both normally ship in one
binary); existing history is not rewritten.

Related: [CLI Role create](../feature/2026-10-07-cli-session-create-agent-role.md).
