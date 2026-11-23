# DeepSeek Harness tool visibility

Status: draft
Translation: current

[中文](deepseek-harness-tool-calls.zh.md)

## Behavior

When a Harness tool executes, the conversation shows its name, input, status and
result. This includes MCP tools and tools dispatched inside `run_code`. Parallel
calls remain distinct, and identical IDs in different sessions never mix.
Approvals show the pending call's details before asking the user to decide.

The provider adapter owns native-to-ACP translation. Existing ACP tool updates
carry the information; no DSH-specific host protocol or execution mechanism is
added. Harness still owns execution, permissions, cancellation and persistence.
Text and image results are visible; unknown content remains inspectable. A failed
presentation or missing image must not erase the call or its native result.
Successful file edits may carry result-time diffs. Pending or failed edits must
not be presented as applied changes. Interrupted calls without recorded results
end visibly with unknown outcome rather than fabricated success.

Only ACP-owned session events are projected. Child-agent transcripts, partial
model argument streams and live subprocess output are outside this contract.
Nested PTC calls use separate rows; this does not guarantee a nested UI layout.

## Evidence

- [Provider implementation](../packages/acp-extension-dsh/src/tool-calls.ts)
- [ACP boundary tests](../packages/acp-extension-dsh/src/adapter.test.ts)
- [Decision and verification](../.agents/notes/implemented/bug-fix/2026-09-24-dsh-tool-visibility.md)
