# Automatic Agent Role schema reconciliation

Status: draft
Translation: pending

After upgrading and opening a workspace, the app automatically reconciles the
current user's saved Roles against their bound agents. No Settings visit, save,
confirmation, toast or success notice is required. The workspace shell starts the
work after catalog readiness; offline targets wait until they become available.

Only a successful runtime capability refresh for the exact machine and agent
configuration, matching its runtime override and the client's current cache format,
may authorize removal. Static defaults, absent schemas, failed probes and older or
newer cache formats never authorize destructive reconciliation. This restriction
applies to automatic writes only; ordinary cache readability remains governed by
[cache compatibility](acp-capability-cache-compatibility.md).

Remove option keys the fresh schema no longer advertises. Preserve values of
advertised fields even when invalid, along with model and permission pins. Explicit
permission, approval and sandbox options remain visible for manual correction.
When a retired `collaboration_mode` contains `default` or `plan` and the new schema
advertises boolean `plan_mode`, preserve that choice as false or true. An existing
`plan_mode` wins. A retired `interaction_mode: plan` also migrates to true when
neither the new field nor a recognized legacy collaboration choice exists.
New optional defaults are not pinned during maintenance.
For other option removals, a Role's pinned model must match the probe's model;
otherwise retain potentially model-dependent keys until their support is known.

Only the Role owner may persist reconciliation. Delayed results must not recreate
deleted Roles or overwrite intervening edits. A changed Role advances its revision
once; repeating reconciliation without further changes performs no write. Already
accepted Operations and Session provenance remain frozen.

Writes resolve locally and upload independently through the existing catalog path.
Failed probes or writes preserve the original Role; reopening retries automatically.
Reconnect also retries failed probes. No global "upgrade complete" flag may suppress
work for a Role or machine that was unavailable during the first launch.

Evidence: `packages/components/src/hooks/use-agent-role-schema-reconciliation.ts`,
`packages/components/src/lib/agent-role-schema-reconciliation.ts`, and their tests.
