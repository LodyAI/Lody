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

Workspace startup also reconciles owned Roles against fresh runtime schemas without
opening Settings. A conditional writer transaction fences delayed probe results
against edits and deletion, then uses the same durability/upload split. See the
[schema reconciliation Spec](../../specs/agent-role-schema-reconciliation.md) for
which options may be removed and which pins remain user decisions.
