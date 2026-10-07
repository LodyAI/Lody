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

## Daemon upgrades and autostart

Remote upgrades install globally using the daemon's npm environment, resolve the
installed package's declared CLI entry via `npm root -g`, and verify its version.
The watchdog launches that entry explicitly and only reports upgrade success after
the replacement reaches ready with the same version. A successful npm install alone
does not prove that the running daemon upgraded. Verification or handoff failure is
logged as failure; the existing restart recovery remains available.

Autostart scripts, scheduled tasks, and service definitions must invoke the stable
global installation, not an absolute `_npx` cache entry or a version-specific store
path. This repository does not generate or rewrite user-owned autostart scripts.
If an existing daemon was launched from such a pinned path:

1. In the same OS environment and user account as the daemon, install the desired
   version globally. Windows and WSL have separate installations.
2. Find the global prefix with `npm prefix -g`. On Windows the stable launcher is
   `<prefix>\lody.cmd`; on Linux/WSL/macOS it is `<prefix>/bin/lody`.
   Check that launcher's `--version` before using it. Use the same Node/npm
   installation and preserve the script's environment and daemon arguments.
3. Replace the old cache path in the autostart command with that absolute launcher.
   In PowerShell invoke a quoted launcher with `&`. Ensure the task's PATH includes
   the intended Node runtime; WSL tasks must use the launcher inside that distro.
4. Use the verified launcher to run `daemon stop`, then `daemon start` with the
   original options, and check `daemon status` and the startup log's CLI version.
   Restart the watchdog too: restarting only its Worker leaves old upgrade code alive.

An already-running old watchdog cannot acquire this fix merely by downloading it;
the one-time launcher correction and restart are needed for that deployment.
Older releases without versioned readiness cannot be verified by the new remote
handoff and must be started explicitly if a rollback is required.

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
manual configuration. `lody session create --agent-role <idOrName>` resolves a
workspace Role the same way: the Role's machine, agent config, run configuration,
and prompt prefix win over `--machine`/`--agent`/`--agent-config`/`--mode`/`--model`/
`--config-option` (ignored flags are listed in a warning), while `--repo`/
`--local-project`/`--branch`/`--worktree` still supply the work context.
Merge, Plan and retry behavior: [creation contract](../../specs/session-orchestration.md#session-creation-configuration).

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
