# MCP sidebar sub-conversation guidance

Status: implemented
Translation: current

[中文](2026-10-27-mcp-session-placement-guidance.zh.md)

## Abstract

MCP creation described Tab containment as a “child,” making it easy to confuse
with a sidebar sub-conversation. Single and batch tools now tell agents to pass
`useCurrentSessionAsParent=false` by default and use `true` only for explicit Tab
requests. This changes guidance only; existing runtime defaults stay intact.

## Decision and limits

Both tool descriptions and published field descriptions carry the rule. Explicit
`false` matters because same-machine Local Project Role creation can infer `true`
when the field and `workContext` are omitted. Batch guidance sets the value in
`defaults`, allowing explicitly requested Tabs per item. Project selection remains
available through `workContext` for independent sessions.

The [MCP README](../../../../apps/cli/src/mcp/README.md#session-placement-guidance)
records the behavior, consistent with [session relations](../../../../specs/session-relations.md).
No dispatch, schema acceptance, or runtime default changed. Verification checks
formatting and documentation; agent adherence requires real usage and is not
claimed as a measured outcome.
