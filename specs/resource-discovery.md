# MCP and CLI resource discovery

Status: draft
Translation: current

[简体中文](resource-discovery.zh.md)

An Agent must be able to discover stable resource ids before creating work, inspect
why a readable target cannot run, and recover the list of Operations it requested.
CLI and MCP use the same directory query service and safe projections.

## Behavior

Machine, project, Agent configuration, Agent Role and workspace MCP directories
support bounded list queries. Agent configuration and Role details accept stable
ids. List queries default to 20 entries, allow 1–100, and return `items`, `hasMore`
and optional `nextCursor`. Cursors bind resource, workspace, reader and filters;
changing the page size is allowed. Ordering uses stable resource identity. This is
live keyset pagination, not a frozen snapshot; newly inserted earlier keys require
a new traversal. Local project identity includes its machine id. GitHub entries
represent enabled workspace repositories and have no machine binding.

Only authorized resources are returned. MCP identity comes from the active runtime
Turn. Role list/get follows `canReadAgentRole`; this does not change the separate
explicit-id Role creation contract. Readable unavailable Roles remain listed with
binding, machine, model or permission-mode reasons. Missing
presence/capability information is unknown, not proof of unavailability. Availability
does not replace dispatch validation or guarantee future availability.

Agent summaries include model/run capabilities but exclude launch configuration.
MCP summaries exclude connection values entirely. A known active Turn selection is
reported separately from catalog configuration; absent selection data stays absent,
and selected does not imply successfully loaded. Role prompt prefixes are detail-only;
run options use the existing sensitive-field normalizer.

Operation listing is scoped to workspace, requester Session and invoking/authenticated
user on the owning machine's SQLite store. It supports state filtering and bounded
keyset pagination. Summaries contain ids, kind, state, timestamps and item counts,
never prompts or assistant output. It does not change automatic completion delivery.

Session list gains case-insensitive title/id search and exact machine, Agent config
and Role creation-provenance filters before existing pagination/status work.

## Compatibility and limits

`session_create_options` stays sparse and documents its 20-match search limit;
complete traversal belongs to directory list tools. CLI workspace directory lists
now return paginated safe summaries and support `--all-pages`; resource-specific
JSON array aliases remain. The local daemon project listing, trusted Agent config
`show`, and explicit legacy detailed machine output remain available.

The existing cloud workspace runtime supplies the initial integration. New CLI
workspace queries fail before cloud I/O in the local composition. Catalog offline
reads still require authorization connectivity; repository listing is online-only.
Catalog synchronization failures fail the read rather than claiming an empty result.
Operation CLI queries its local store, not a cross-machine aggregation service.

## Evidence

- [Query and pagination](../apps/cli/src/lib/discovery-query.ts)
- [Directory service](../apps/cli/src/lib/resource-discovery.ts)
- [MCP tools](../apps/cli/src/mcp/discovery-tools.ts), [CLI boundary](../apps/cli/src/commands/discovery.ts)
- [Operation store](../apps/cli/src/orchestration/operation-store.ts)
- [Decision](../.agents/notes/implemented/feature/2026-09-27-resource-discovery.md)
