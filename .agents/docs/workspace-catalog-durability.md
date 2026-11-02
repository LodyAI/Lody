# Workspace catalog durability and Role configuration

Local catalog persistence and remote sharing finish at different times. This explains
the [root catalog rules](../../AGENTS.md#repository-boundary); it does not introduce
another catalog or write path.

An MCP server or Agent Role row already exists once its local Flock write is durable.
The explicit upload follows that write, and a joined room can carry the document
when the one-shot upload cannot. Waiting for that upload in Settings confuses a
sharing delay with a failed edit. Reporting it as an edit failure can prompt a
duplicate retry; an upload banner offers no actionable correction to the saved row.
The CLI's explicit sync result answers a different question and remains visible.

A Role is a row in the workspace document even when its visibility is private.
Visibility does not prevent the underlying row from reaching other workspace
members' clients. This is why sensitive configuration is filtered on reads as well
as writes and why private visibility cannot make the catalog a secret store.

Permission mode is an agent-published run-config value, not a secret or a separate
auto-approval policy. A Role can pin it with the rest of its configuration, making a
second composer permission control redundant. When that control disappears, its
warning must remain visible for full-access or skip-permission modes. Presentation
details live in [composer run config](sessions-run-config.md).

An accepted Operation captures the resolved Role configuration rather than rereading
a mutable catalog on retry. Otherwise editing or deleting a Role could change what
an already accepted request executes. Session provenance describes creation; it is
not another configuration authority.

A Role's optional description gives other agents short guidance on when to call
it. The editor and shared normalizer cap it at 140 Unicode code points; discovery
list/get results expose it separately from the execution prompt prefix. Older rows
without the field display as blank. See the [description Spec](../../specs/agent-role-description.md).

Explicit Save reconciles the Role's option values against the selected agent's
authoritative, model-specific editor controls. It drops retired keys, retains valid
choices and uses current defaults for unset or invalid values. Opening or cancelling
the editor does not rewrite the catalog. Missing/provisional capabilities preserve
stored options; model and mode pins remain explicit user choices. The existing
content comparison advances the revision once when reconciliation changes the row.

Workspace startup also reconciles owned Roles against fresh runtime schemas without
opening Settings. A conditional writer transaction fences delayed probe results
against edits and deletion, then uses the same durability/upload split. See the
[schema reconciliation Spec](../../specs/agent-role-schema-reconciliation.md) for
which options may be removed and which pins remain user decisions.

A Role can also carry a machine-scoped memory identity reference. The daemon's
Provider adapter owns commands and environment mapping; neither memory contents
nor credentials enter the workspace catalog. A new turn freezes the reference,
and switching it retires the old ACP process without publishing an agent-death
event against the new turn. See the [memory Spec](../../specs/agent-role-memory.md).

Memory associations are machine-document rows keyed by
`['memory', providerId, memoryId]`, separate from workspace Role references.
They store a display name and description, not memory contents. The same writer
durability/upload split applies. Linking is put-if-absent; editing cannot resurrect
a deleted row. Deleting an association leaves the external identity and existing
Role/turn references intact. See the
[association decision](../notes/implemented/feature/2026-10-05-memory-association-catalog.md).

Project MCP defaults share this workspace document as one optional ids-array row
per project. Missing rows inherit catalog defaults; present rows replace them,
including an empty selection. Authoring resolves these defaults before accepting
a new conversation, while continuation inherits the target conversation selection.
The existing per-turn and Operation target configurations carry the resolved ids;
startup and recovery do not reapply project policy. The
[project default Spec](../../specs/project-default-mcp.md) describes UI behavior
and acceptance scope.
Memory batch import reuses these per-row writes sequentially. The editor removes
successful rows from its checkbox selection, stops on the first failed write, and
keeps remaining selections for retry; it does not roll back earlier durable rows.

Agents can propose Role creation or text edits through MCP or `lody agent-role
create/update`. Both publish a conversation card, and only its Save action writes
the catalog using the same local durability boundary. The updater applies only
specified text fields to the latest row, keeping bindings and run configuration.
Concurrent device edits may overwrite one another; there is no cross-device CAS.
The [tool guide](../../apps/cli/src/mcp/README.md#agent-role-proposals) documents
inputs, active-conversation requirements and retry receipts.
