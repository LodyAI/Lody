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

## Local encrypted execution log recovery

Stop the journal's execution owners, then run:

```sh
lody e2ee journal reset --file /absolute/path/to/journal.sqlite --json
```

The command works offline and returns `archivePath` and `journalPath`. It renames
and preserves the old execution log, creates a fresh log, and retains old current-format
request ID fences in the adjacent `.control.sqlite`. Keep that file and the archive;
unknown results are not automatically retried. Restart owners after reset. Retrying
this command completes an interrupted reset using the same archive path.

A clock error asks you to calibrate the system clock. Without trusted reference time,
a bad observation can still reject new claims in its workspace until explicit reset;
other workspaces and completed evidence remain available. Empty interrupted first
creation initializes automatically. An unknown schema is archived and reported,
then waits for explicit reset. No legacy data is imported.

This maintenance command is available by its explicit name and hidden from general
CLI help. The journal has no product dispatch caller yet, so there is no default
product path or desktop reset button. See the
[recovery decision](../../.agents/notes/proposed/bug-fix/2026-10-27-e2ee-realtime-journal-recovery.md).

## Development type checking

`tsconfig.json` includes source and tests so editor language servers resolve the
CLI's `@/*` imports in both. `pnpm typecheck` uses `tsconfig.typecheck.json` to
retain the production-only check. `tsconfig.tests.json` remains the explicit
test-inclusive check; existing test typing errors are not part of the production
check.

## Roost cache recovery tests

Regular `pnpm test` runs the Native recovery contract with 1 and 120 retained turns
(three 40-turn pages). It checks the complete cached history against the owner and
rejects requests for unchanged pages during recovery.

Run the same assertions with 2,000 turns outside regular CI:

```sh
corepack pnpm --dir apps/cli test:roost-recovery:perf
```

Run this command from the repository root. The scale test allows 120 seconds for
the Native SQLite import; regular setup and recovery each keep a 30-second limit.
Vitest reports recovery's test-body duration separately from the file duration,
which also includes setup. This is a scale regression test, not a network benchmark.

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

The launcher waits up to three minutes for the new Worker to become ready.
Releases before this change waited 30 seconds, and the old watchdog applies
its own limit during the handoff. So on a machine where cold start exceeds
30 seconds, remote upgrades from those releases keep falling back to the old
version. They also fail `daemon start`. Install the fixed release globally,
then run `daemon stop` and `daemon start` with its launcher (steps 2 and 4
above). Later remote upgrades use the longer limit.

## Structured Session output

Session commands with `--json` or `--jsonl` reserve stdout for structured results.
Diagnostic logs, including workspace transport cleanup, go to stderr.

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

## Import Magpie providers on a server

Run on the machine hosting both Lody and Magpie, with Lody signed in and its daemon
running. This uses the existing workspace command runtime, not the OSS local-only
composition. Explicit command execution authorizes the import; no desktop is needed.

```sh
lody agent-config import-magpie --workspace team --json
lody agent-config import-magpie --workspace team --targets pi,codex --gateway http://127.0.0.1:3425 --json
lody agent-config import-magpie --workspace team --link 'lody://provider/import?v=1&data=…' --json
```

Without `--targets`, import all seven (`claude,codex,pi,dsh,kimi,grok,bub`), or all
those offered by `--link`. A target subset cannot expand a link's offered targets.
`--gateway` and `--link` are mutually exclusive. The gateway must be a literal
loopback HTTP origin; upstream credentials stay in Magpie. The command always
uses the invoking machine, ignoring `LODY_MACHINE_ID`; there is no remote-machine
flag. The daemon must advertise `magpieImport` and `providerSetup`, plus `builtinPi`
when Pi is selected. Unsupported selections fail before any writes.

Existing providers are preserved. Repeated imports reuse providers or pending setup
IDs for the same gateway/runtime, and requeue failed setups with their existing
configuration. Managed runtimes and Bub enter the normal daemon setup queue;
DSH is saved directly. Bub still needs a user-installed `bub acp` and ACP plugin.
JSON lists each target, `agentConfigId`, and status (`existing`, `created`, or a
setup status). `queued` is not ready: follow progress in Providers. `synced: false`
means saved locally but publication is unconfirmed; rerun after connectivity recovers.
Import does not verify upstream inference. Startup generates native configuration
from the gateway's live catalog as described in the [Magpie contract](../../specs/magpie-provider-import.md).

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

## Importing OSS records into cloud

In the cloud CLI, run `lody migrate --from-oss`, select an existing workspace, and
confirm the source/target summary. Close the OSS app and CLI first. For scripts,
use `lody migrate --from-oss --workspace <id> --yes`; `--source <directory>` selects
a custom OSS data root. No workspace is created automatically.

This imports full Loro history and referenced local file attachments, keeps existing
cloud conversations/settings, and disables execution of imported sessions/schedules.
Roost and unsupported formats fail before record uploads. Source data is retained;
rerunning resumes the frozen snapshot. It does not copy code directories or native
agent credentials. See [migration and recovery](src/lib/oss-migration/README.md).
