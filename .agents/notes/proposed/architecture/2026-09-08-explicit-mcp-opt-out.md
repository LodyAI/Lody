# Explicit MCP opt-out for the first Pi adapter

Status: proposed
Translation: pending

## Abstract

The Pi adapter rejects MCP while Lody normally mounts its builtin MCP server,
so configuration probing can succeed even though the first prompt cannot start.
The proposed fix adds an explicit, versioned no-MCP declaration to Core and has
Lody consume it at the common session startup boundary. Selected workspace MCP
must produce an actionable refusal, while ordinary sessions remain usable without
agent MCP tools. The scope excludes MCP implementation and ACP v2 migration.

## Ownership and alternatives

[The draft Spec](../../../../specs/acp-mcp-opt-out.md) describes the intended
behavior. Core owns the wire meaning; Pi declares its actual capability and Lody
constructs requests from it. Missing or unknown declarations preserve the old ACP
behavior. A cache is a display projection, not a second capability authority.

ACP v1 has no stdio opt-out field. Inferring no MCP from an omitted standard
field, skipping MCP by agent name, or ignoring selected servers would leave the
contract ambiguous. Implementing MCP now would expand the agreed first release.
The explicit Core opt-out is the smallest shared contract for the accepted scope.

`taskToolsEnabled` is also set by ordinary composers from a global preference.
It cannot be treated as proof that this turn requires agent MCP calls. Removing
builtin MCP removes those tools without disabling Host-owned task workflows.

The [Core contract PR](https://github.com/LodyAI/acp-extension-core/pull/4)
defines the metadata. The Pi executable only emits the new literal. Its existing Core npm
imports remain unchanged; no Git package dependency, install hook or npm release
is necessary. Lody consumes the contract through the Core submodule commit.

## Verification

Review reproduced the pre-fix startup failure through the real ACP boundary.
Focused tests cover ordinary no-MCP startup, selected-server refusal, legacy
behavior, replacement through the shared builder, cache persistence and the three
composer projections. Full workspace checks passed. Independent reviews found no
remaining P0/P1 in the supported paths; a proposed edit-and-resend expansion was
rejected because that entry only supports builtin Codex and Claude, not Pi.
Astra ablations removed a redundant successful-start warning and replaced cache
write-count assertions with a stored-capability readback. Full desktop acceptance
remains pending.
Related: [Lody #451](https://github.com/LodyAI/Lody/issues/451).
