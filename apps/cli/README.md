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

## Agent session identity

Agent processes and their ACP terminals receive `LODY_SESSION_ID` and
`LODY_WORKSPACE_SESSION_ID`. The workspace owner id is the parent Session id for a Tab,
or the current Session id for an independent Session.

`LODY_AGENT_ROLE_ID`, `LODY_PARENT_SESSION_ID`, and `LODY_OPENED_BY_SESSION_ID`
expose the current Session's Role, parent, and exact opener ids. Absent values
are unset, including values inherited from the host or login shell. These ids
require no lookup before a create. They contain no Role name or prompt and do
not change create defaults.

`SessionManager` reads Role and opener provenance from the Session metadata at
the common process startup boundary. `SessionConfig` carries them to
`Session.buildShellEnv` for creation, restoration, edit-and-resend, and forks.
The parent id follows the existing workspace configuration. This avoids separate
copies at every configuration constructor. Desktop manual PTYs use
`terminal-pty-service`, outside this agent environment contract.

## Manual terminals

Desktop terminals stay alive when a conversation is stopped or its idle agent
runtime is reclaimed, including under memory pressure. Fleet owns these PTYs
independently of the agent process, so running shell commands survive until the
terminal is explicitly closed, the conversation is archived/deleted, or the app
shuts down or restarts. Shell exit still ends its terminal normally.

## Automations

`lody automation` registers durable JavaScript conditions that return results to
the same Session, and configures native quota recovery, merge archive and idle
compaction. See the [module guide](src/automations/README.md) for the API, execution
authority and examples. Existing recurring Schedules retain their execution owner.

## Encrypted remote execution authorization

The encrypted workspace host exposes
`authorizeExecution(workspaceId, requesterDevice, localProjectId?): Effect<ExecutionAuthorization>`.
The requester is the lowercase hex signing public key from an independently verified
request. The result is `Authorized`, or `Denied` with `invalid-request`,
`not-authorized`, `e2ee_machine_not_shared`, `unavailable`, or `closed`. Use it immediately before a new execution;
request integrity, target binding and the durable journal claim remain separate checks.

The machine reads the ledger with its own device credential and verifies every page
through the existing runtime. Grants are isolated by workspace host and requesting
device, kept only in memory for less than 15 minutes from read start, and checked
against currently known membership on every call. Owner/Admin/Member personal or
machine devices qualify directly when they share the target machine's verified ledger
membership. Cross-member execution requires a current owner-signed machine policy
and, for a local project, its project switch. Missing authorization returns `e2ee_machine_not_shared` (“机器或本地项目未共享，请联系机器所有者”). See the [native policy host](../../packages/e2ee-machine-sharing/README.md).
Guest, recovery, removed and revoked devices do not qualify.
Restart requires another authenticated read. A connection or forwarded proof cannot
renew a grant. Concurrent misses share a refresh, bounded to 30 seconds; failure
rejects those new execution requests and permits retry without stopping local editing,
already running work or other workspace hosts. No RPC/agent dispatch is enabled by
this interface alone.

Execution identity comes from the verified original update's device and ledger
actor. UI account IDs are display metadata: they neither grant nor deny execution
and are never compared with crypto user IDs. The host checks the signing device's
current membership, role, revocation and machine/project authorization before a
new claim. Ordinary workspace visibility/project-sharing checks remain unchanged.

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
claims use the current local clock, so correcting a bad forward observation recovers
new claims without reset. Started request IDs still cannot execute twice, and
completed evidence remains available. Empty interrupted first
creation initializes automatically. An unknown schema is archived and reported,
then waits for explicit reset. An incomplete current-format store still retires all
readable request keys before archival; unreadable current request keys refuse reset
and preserve the original for repair. No legacy data is imported.

This maintenance command is available by its explicit name and hidden from general
CLI help. Encrypted agent starts, including Meta/history dispatch and RPC offers,
share a `userTurnId` execution claim in `execution.sqlite` under the active encrypted
workspace's `repositoryDirectory`. Stop the daemon before reset. There is no desktop
reset button. The execution gate verifies the signed execution intent stored with the
turn row against the content that will run, checks its signer in the current ledger, then
calls the same host's `authorizeExecution(workspaceId, requesterDevice)` by default.
`LodyOptions.authorizeEncryptedExecution` can override this capability with the same
signature. A missing or invalid signature, an unknown signer after an authenticated read,
or missing authorization refuses the start with its reason; revoking a device cannot borrow
another device's authority from the same user. No original frame, Streams backfill or time
window is involved, so a snapshot or a late arrival carries the same evidence
([decision](../../.agents/notes/implemented/architecture/2026-11-10-e2ee-signed-execution-intent.md)).
Only an unreadable ledger leaves a turn pending. A received frame for the session, a
confirmed ledger read, a key installation or an RPC reconnect rechecks a waiting turn at
once; a fallback timer doubles from one second to at most five minutes. Stop cancels the
watcher's delayed retry. A cancelled input that never started is retired in the journal.
Member removal retains its identity-verified receipt/erasure path; single-device
revocation closes the workspace while retaining local state.
Ordinary workspaces do not open this log.
Transport frames keep their own original request/response receipts; execution evidence
contains intent identities and a settlement marker, never prompt or response plaintext.
See the
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

Two V8 OOM exits within thirty minutes pause automatic launches for ten minutes.
The host and lease stay alive; after cooldown one recovery launch resets the OOM
window. Another OOM pair starts a fresh cooldown. Explicit start/restart recovers
immediately; stop cancels recovery. Authentication, protocol and ownership failures
retain their existing terminal behavior.

Interactive startup retains a three-minute hang backstop; see the
[cold-start decision](../../.agents/notes/implemented/bug-fix/2026-10-16-daemon-ready-timeout-slow-cold-start.md).

Managed daemon updates use a fixed SEA service entry and immutable SHA-256-checked releases.
The entry holds the Host lease while replacing its Worker, using a pinned ordinary
Node for external JavaScript. No remote `npm install`, login shell, system Node,
native compilation or global prefix write is involved. The npm CLI remains JavaScript.

The cloud connection dialog now provides a standalone Shell installer for
macOS/Linux and a PowerShell installer for Windows. It checks the capsule's archive
and raw hashes and lets the verified capsule install its exact ordinary Node. The
credential stays out of public download URLs and autostart definitions. The script
installs the fixed entry, signs in, registers future autostart where available, and
waits for the initial daemon-ready handshake. With `--no-start`, only installation
is performed. Autostart failure is reported separately; the current connection can
still run. Existing/modified service definitions are preserved. Linux user services
may require lingering to stay available after logout; Windows uses a current-user
login task without the scheduler's default execution-time or battery stop limits.

Existing npm daemons require one explicit local migration:

1. Stop the identified old service and disable its autostart registration.
2. Download the matching product/platform SEA from a trusted release source and
   verify its SHA-256 and any supplied platform signature (required on macOS, optional
   on Windows). Run `/absolute/path/to/daemon daemon install`.
   This downloads the exact additional Node pinned in the executable; offline
   installations can first run `__sea-install-node /absolute/path/to/node.gz`.
3. Register the printed fixed executable with `daemon-runner` in your user service,
   preserving arguments and `LODY_DATA_DIR`. Installation prints instructions and
   never rewrites an arbitrary existing service or launches a second host.
4. Run that fixed executable with `daemon start` and check `daemon status`.

On a managed macOS/Linux glibc installation, `daemon upgrade` prepares a SHA-256-checked
release while the old daemon serves, then waits for active turns to finish.
`--immediate` explicitly interrupts work after preparation. `--channel nightly`
selects Nightly; `--allow-channel-change` and `--allow-downgrade` confirm those
changes. The UI chooses the initiating client's build channel and asks for
confirmation. `daemon update-status [--request-id ID]` reads durable outcomes.
A failed download leaves the old daemon running. Unconfirmed termination blocks
replacement; a clean candidate failure restores the compatible retained release
once. Remote disconnection does not roll back a locally healthy daemon.

Windows automatic updates and encrypted remote lifecycle control are unavailable
until their ownership/authorization contracts are implemented. Containers and
external package managers retain update ownership. Fixed-entry upgrades remain
an explicit local installer operation. Releases are retained without automatic
cache collection. See [SEA packaging](scripts/sea/README.md) and the
[installation contract](../../specs/daemon-upgrade-installation.md). The
[ownership decision](../../.agents/notes/implemented/bug-fix/2026-10-03-daemon-upgrade-installation.md)
explains why npm handoff and self-replacement were removed.

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

## Local export

`lody export` includes encrypted workspaces, including `--all-workspace`. The
workspace manager reads verified, decrypted session documents through the same
protected replica used by chat, then writes JSON and Markdown on this device.
`--offline` reads its retained local cache. Unsupported encrypted schedule rooms
are omitted; ordinary workspace exports keep their existing schedule data.
Desktop conversation copy and image export likewise use the local history and
save/clipboard bridges, without publishing a share.
