# DSH 0.2 tool-result projection regression

Status: implemented
Translation: current

[中文](2026-10-10-dsh-tool-result-format.zh.md)

Provider PR: [acp-extension-dsh #30](https://github.com/LodyAI/acp-extension-dsh/pull/30)

## Abstract

The Harness 0.2.0-rc.2 upgrade changed native tool-result messages, but the ACP
adapter still validates the previous nested block format. A valid text result
therefore fails projection and makes prompt settlement report `assistant output
delivery failed`, even when native execution completes. The provider-owned bridge and its fixtures now follow the pinned native contract.
Regression coverage checks live settlement and history replay, with a native
constructor probe guarding against obsolete synthetic fixtures.

## Evidence and responsibility

- The installed `@deepseek-ai/dsh-llm` 0.1.5-rc.2 `createToolResultMessage`
  creates a user message containing a `type: 'tool-result'` block with
  `toolCallId`, `content`, and `isError` inside that block.
- The same function in pinned 0.2.0-rc.2 creates a `role: 'tool'` message with
  `toolCallId`, `content`, and `isError` directly on the message. Its content
  contains ordinary text/image blocks; `source` identifies the tool call.
- [ToolCallBridge](../../../../packages/acp-extension-dsh/src/tool-calls.ts)
  previously parsed `message.content` as an array of the old result blocks.
  Passing a synthetic text result from the actual 0.2.0-rc.2 constructor to
  that schema reproduces the three errors at `message.content[0]`: unexpected
  `type`, missing `toolCallId`, and missing nested `content`.
- [Adapter output delivery](../../../../packages/acp-extension-dsh/src/adapter.ts)
  catches the projection failure into `inflight.outputError`. Prompt settlement
  rejects after output drains, so a delivered final answer and a failed ACP
  prompt are compatible outcomes. Unfinished projected calls are interrupted
  with unknown outcome despite a native recorded result.
- [History replay](../../../../packages/acp-extension-dsh/src/session-history.ts)
  invokes the same bridge. The existing
  [adapter tests](../../../../packages/acp-extension-dsh/src/adapter.test.ts)
  previously manufactured the nested result shape, masking this incompatibility.

This identifies a missed boundary in the
[Harness upgrade](../feature/2026-10-09-dsh-harness-upgrade.md).
The [tool visibility Spec](../../../../specs/deepseek-harness-tool-calls.md)
already requires result visibility; its intent does not need changing.

## Repair and validation

The bridge parses `role: 'tool'`, `toolCallId`, `content`, and optional `isError`
at message level, preserving native message fields and event metadata in raw
output. Malformed results still fail delivery. Native
`dsh-session-format-v3-to-v4` converts old user-role wrappers to tool-role messages,
so the adapter does not introduce a second legacy-format path.

The owning adapter suite now uses the current format for success/error results,
metadata, images, session isolation, and replay. Added prompt-level regression
cases cover success, tool failure, empty content, and malformed results. The
existing core-capabilities native probe also passes messages from the actual
0.2.0-rc.2 `createToolResultMessage` through the bridge and checks terminal output.
No captured transcript is included; all fixtures are synthetic.

Validation in a separate provider clone: `npm run build`, all 61 unit tests,
`npm run format:check`, and both real-runtime core-capabilities probes passed.
All three new valid-result prompt regressions fail against the original bridge.
Root `pnpm check` and `pnpm format` were attempted but stopped on missing worktree
dependencies (adapter TypeScript dependencies and Oxfmt). Root docs check still
reports existing links into uninitialized unrelated submodules; neither new note
has a reported error. No live model call or desktop packaging was tested.
