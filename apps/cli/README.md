# Lody

[lody.ai](https://lody.ai)

Orchestrate your coding agents, together:

```
npx lody start
```

Install the CLI package:

```
npm install -g lody@next
```

## Workspace discovery

The cloud workspace CLI and Lody MCP share resource queries. Lists return 20 entries
by default (maximum page size 100), `hasMore` and an optional `nextCursor`. Continue
with the same filters, or use CLI `--all-pages`. JSON includes `items` plus the
resource-specific alias (`machines`, `projects`, `agentConfigs`, `roles`, `servers`).

```sh
lody machine list --workspace team --all-pages --json
lody project list --workspace team --kind local --all-pages --json
lody project list --catalog --kind github --query example --json
lody agent-config list --workspace team --machine workstation --json
lody agent-config get AGENT_ID --workspace team --json
lody agent-role list --workspace team --json
lody agent-role get ROLE_ID --workspace team --json
lody mcp list --workspace team --json
lody operation list --workspace team --session SESSION_ID --state active --json
lody session list --workspace team --query parser --machine-id MACHINE_ID --agent-role-id ROLE_ID --json
```

Matching MCP tools are `lody_machine_list`, `lody_project_list`,
`lody_agent_config_list/get`, `lody_agent_role_list/get`, `lody_mcp_list`, and
`lody_operation_list`. Session list adds `query`, `machineId`, `agentConfigId`,
and `agentRoleId`. Creation provenance is what the Role filter matches.

`lody_session_create_options` and Agent config discovery expose `runConfig.modes`
and `runConfig.configOptions` (ids, types and choices, without current values).
Single and batch MCP creates accept `modeId` and `configOptionValues`, matching
CLI `--mode` and `--config-option` validation against target capabilities.
For example, a Grok target may use `configOptionValues: { permission_mode: "ask" }`;
its ACP mode `default` is not a permission policy. Explicit permissions may exceed
the parent; callers must follow their user authorization. Roles still override
manual configuration. Merge, Plan and retry behavior: [creation contract](../../specs/session-orchestration.md#session-creation-configuration).

`project list` without catalog options retains the local daemon project listing.
Workspace project listing now spans authorized machines and enabled GitHub repositories;
`--machine` restricts it to local projects on that machine. Directory lists are
paginated summaries rather than the old unbounded/full configuration dumps.
`agent-config show` inspects a configuration with environment values hidden;
`get` returns the safe discovery projection. Legacy `machine list --include-agents`
and `--include-acp-capabilities` retain their detailed output and cannot combine with
directory pagination/filter flags.

MCP entries omit all connection values. MCP reports the active Turn selection only
when known; selection does not prove successful loading. CLI has no active Turn and
omits that field. Role list/get follows visibility and retains unavailable entries;
get additionally returns the prompt prefix. Availability is a cached observation,
not a reservation or permission to bypass dispatch validation. Operation listing
reads only the local machine's store and requires a requester Session (`--session`
or `LODY_SESSION_ID`); it never aggregates remote machine stores.

These workspace queries use the existing cloud command runtime. The OSS local
composition does not enable cloud queries; local project listing remains available.
Catalog `--offline` skips catalog synchronization but still verifies authorization;
GitHub repository listing requires connectivity.

## Agent configuration output

`agent-config show [id] [--json]` returns sorted `envKeys`, not environment values.
Text output marks every key `[configured]`, including empty values. For deliberate
inspection, `show --show-secrets` includes the original values (`env` in JSON).
That output may contain credentials: use it only where the output is trusted.
The flag is only available on `show`; list/get remain safe discovery summaries.

JSON create/update responses contain `ok`, `workspaceId`, `agentConfigId` and
`changedFields` (initialized/requested field names, not values), rather than `agentConfig`.
Scripts should read `agentConfigId` for the saved id and use a separate `show`
when inspection is needed. Scripts reading `show.agentConfig.env` must explicitly
opt in to secret output, or migrate to `envKeys`. The output is a presentation
contract, not a full configuration backup; runtime/auth/custom-launch fields are
not exported. No masked placeholder is stored or returned as an environment value.
Assignment errors report entry/line numbers without echoing their contents.
