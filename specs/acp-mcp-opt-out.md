# Agents without MCP

Status: draft
Translation: pending

A user can run an agent that explicitly implements no MCP. Ordinary prompts,
native tools, steering and native session resume remain available. The agent has
no builtin Lody MCP tools or workspace MCP servers; Host-owned task creation,
linking and status do not become unavailable solely for this reason.

The adapter declares this through the versioned Core MCP opt-out. The declaration
is the capability authority; Lody derives session startup and capability displays
from it. Agents without a recognized declaration retain standard ACP behavior.

An agent session can start with no selected MCP servers without mounting builtin
servers. Starting, restoring, or replacing an agent session with a nonempty
workspace MCP selection must fail with an actionable request to remove the
selection or choose a supporting agent. Neither startup fallback nor a cache
refresh may silently discard that selection. In an existing session, selection
changes apply at the next startup, as shown by the composer. The adapter still
rejects unsupported nonempty lists from older clients that do not recognize the
declaration.

This first Pi integration does not implement MCP or upgrade ACP to v2. Future MCP
support must advertise and implement its actual transports. It must not be
inferred from a provider name or from absence of the current declaration.

## Evidence and limits

The Core contract lives in `packages/acp-extension-core`; the client boundary is
`apps/cli/src/agent/agent-client.ts`. Independent review reproduced the previous
startup mismatch: Lody mounted builtin MCP and Pi rejected the session. The
implementation and its startup/UI acceptance remain under review. This document
is a draft for human review, not evidence of completed desktop acceptance.
