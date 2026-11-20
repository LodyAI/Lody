---
name: lody-cli
description: Drive Lody from a terminal with the `lody` CLI (installed globally or run as `npx lody`) — sessions, schedules, automations, agent configs, Roles, MCP servers, projects, machines, the background runtime, sync/export and review rendering. Use when any agent, inside a Lody session or an external coding agent, needs to hand work to Lody agents, chat with or watch Lody sessions, inspect workspace resources, or manage the Lody runtime on a machine.
---

# Lody CLI

This guide covers the cloud edition of Lody (distributed via `npm i -g lody` and
`npx lody`), including its account sign-in and shared workspaces. The open-source local
edition (the default when building from the public repository) is outside this guide's
scope; do not apply these sign-in prerequisites to it.

## How to call it

- Installed globally (`npm i -g lody`): run `lody …`.
- Without installing: run `npx lody …`. Every `lody` command in this guide works the same
  way with the `npx` prefix. Inside scripts, use `npx -y lody …` to skip the install
  prompt.
- Requires Node.js 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x) on x64/arm64.
- Check which one is available with `lody --version` or `npx -y lody --version`, and stick
  to that form for the whole task.

`lody` does two jobs. It runs the Lody runtime that executes agents on this machine
(`start`, `daemon`). It also works as a one-shot client for workspace resources: sessions,
schedules, automations, agent configs, Roles, MCP servers and projects. Exact flags come
from built-in help: `lody <group> [<sub>] --help`. This guide covers what help leaves out:
prerequisites, shared conventions, business rules and the actions to confirm first.

## Before running anything

1. **Sign in when required.** Reuse an existing login; if a command reports missing or
   invalid Lody credentials, do not run a bare `lody login` from an agent. It waits for
   browser authorization and can block without visible output when stdout is not a
   terminal. Have the user run `lody login` in their terminal, or use
   `lody login --auth <key>` with a CLI API key or machine connection token the user
   provides. Workspaces, sessions, agent configs and machines are shared across every
   machine signed in to the same account.
2. **Runtime.** Commands that run agents on this machine need the Lody runtime. Start it
   in the foreground with `lody start` or in the background with `lody daemon start`.
   - If it is not running, the command fails and says so. Start the runtime first.
   - If it is busy, retry later.
   - Each machine has only one runtime. When the Lody desktop app is open, it already owns
     the runtime and `lody start`/`daemon start` refuse to start another. That is
     expected: the CLI uses the app's runtime.
3. **Where you are calling from.**
   - **Inside a Lody session**, the agent's environment has `LODY_SESSION_ID`, and usually
     `LODY_WORKSPACE_ID` and `LODY_AGENT_CONFIG_ID` (plus `LODY_AGENT_SESSION_ID` for
     agent children). Many commands use `LODY_SESSION_ID` when you leave the matching
     argument out:
     - the session commands' `sessionId`
     - `operation list --session`
     - `agent-role create/update --session`
     - `automation register/list/activities/settings/configure --session`
     - `--use-current-session-as-parent` and `--opened-by-current`

     If `LODY_WORKSPACE_ID` or `LODY_AGENT_CONFIG_ID` is absent, pass `--workspace` or
     `--agent-config` explicitly; do not assume those variables are set.

     To act on a _different_ session, pass its ID explicitly.

     When `LODY_AGENT_SESSION_ID` is set, `lody schedule` allows only `list`, `show` and
     `pause`; creating or changing schedules requires a human action (use Lody's built-in
     MCP tool `lody_schedule_propose` to post a confirmation card). For batch session
     orchestration or automatic completion callbacks inside a Lody session, prefer Lody's
     built-in MCP tools (`lody session` operates on one session per command).

   - **From an external agent** (any coding agent or script outside Lody), none of these
     variables are set. Pass everything explicitly:
     - session ids
     - `--workspace`, when you have more than one workspace
     - the target `--machine` and `--agent-config`, or an `--agent-role`

     Commands that target a session (`agent-role create/update`, `automation *`,
     `operation list`) need `--session <id>`.

## Choose the command from the request

| User intent | First action and next step |
| ----------- | -------------------------- |
| Give a named Role a new task | Find it with `agent-role list --json`, inspect it with `agent-role get <id>`, then use `session create --agent-role <id>` (add `--machine <machineId>` if the Role targets several machines). |
| Start a new task with a particular agent | Resolve the workspace, machine and agent config, then use `session create`. |
| Continue earlier work | Find the existing session with `session list --query <text> --json`, check `show`/`history`, then use `session chat <id>`. |
| Check progress or read a result | Use `session status`, `observe` or `history`; reading does not require sending another prompt. |
| Run later or repeatedly | Resolve the target and time zone, then use `schedule create --file <draft.json>` (outside a Lody Agent session; inside one, propose via Lody MCP). |
| Wait for a condition or configure session recovery/maintenance | Use `automation register --file <check.js>` or `automation configure --file <settings.json>` (or Lody MCP `lody_automation` inside a session). |

Reuse IDs returned by discovery commands. If several candidates still fit the request,
ask which one the user means before dispatching. For repository work, resolve the repo
or local project too; for plain chat, omit project selection.

## Typical flow: hand a task to a Lody agent

1. `lody workspace list --json` to get the workspace. Add
   `machine list --online-only --json` if the target is not this machine.
2. `lody agent-config list --json` (or `agent-role list --json`) to choose who should run
   it.
3. Choose the work context:
   - **Reuse a parent session's project:** `--parent <id>`, or
     `--use-current-session-as-parent` inside a Lody session.
   - **Pin a registered local directory:** `--local-project <id|name|path>`. The project
     must be registered on the target machine; run `lody project add <path>` there. Add
     `--worktree` to keep the session off your checkout.
   - **Use a GitHub repository:** `--repo owner/repo`. Check `lody github list --json`
     first, because `--repo` accepts only repositories linked to the workspace.
4. Add the context flag from step 3 and run:
   `lody session create --workspace W --agent-config C --wait --json "task…"`.
   It starts the session and waits for the reply. Without `--wait`, it returns the session
   id right away.
5. Follow up with `lody session chat <id> --wait "…"`.
6. Read the result with `lody session history <id> --json`, or check progress with
   `session status <id>`.
7. Check the reply and its reported verification against the user's requested outcome.
   A finished turn is not proof that the task succeeded; report failures, missing
   verification or remaining work explicitly.

Without `--machine`, `session create` targets this machine, the parent's machine, or the
Role's machine. Without `--agent-config`, it reuses the current session's config, or the
machine's only config; a Role supplies its own. With several configs and no Role it fails
and asks for one. `--parent` and `--use-current-session-as-parent` already carry the
parent's project, branch and machine; do not combine them with `--repo`, `--local-project`,
`--worktree` or `--branch`. `--worktree` requires `--local-project`; `--branch` requires
`--repo` or `--local-project`. With a single-machine `--agent-role`, omit `--machine` and
`--agent-config`; the Role supplies them. If the Role targets multiple machines, pass
`--machine <machineId>` (or pass a target alias to `--agent-role`).

## When something fails

### Login and authentication

Distinguish Lody account authentication from the selected agent/provider's credentials.
Use the reported error to choose the next step.

**From an agent, never run a bare `lody login`.** It waits for browser approval; when
stdout is not a terminal, it can sit with no visible output. Have the user run it in
their terminal, or have them provide a CLI API key and run `lody login --auth <key>`
through an approved secret channel. Do not paste the key into the conversation.

| Symptom | Next step |
| ------- | --------- |
| Missing or rejected Lody credentials | Have the user sign in from their terminal, or use `lody login --auth <key>` with a key the user provides. An existing valid login is reused. |
| Browser does not open (when the user runs it) | Give the user the authorization URL printed by the CLI to open manually; keep the pending login running. Browser authorization requires the user's action. |
| Authorization code expired or authorization timed out | In the user's terminal, start a new `lody login` and use its new authorization URL; do not keep a stale login running. |
| Authorization denied | Report the denial and stop automatic retries. |
| Network error, auth service unreachable or validation unavailable | Preserve saved credentials, check connectivity and retry after recovery. Do not use logout or cache reset as a network repair. |
| Non-interactive daemon start requires login | Have the user run `lody login` in a terminal, or use an already available CLI API key or machine connection token through an approved secret channel. Do not ask them to paste secrets into the conversation. |
| Lody commands work, but the selected agent/provider reports an authentication error | Inspect the selected agent config without `--show-secrets`; follow that agent/provider's authentication instructions on its target machine. Repeating Lody login does not repair provider credentials. |

Common CLI auth errors are ``Not logged in. Run `lody login` first.``,
``CLI token is invalid or expired. Run `lody login` again.``, and
``Invalid API key. Generate a new key and retry.`` Use a read-only command such as
`lody workspace list --json` to probe authentication: success means the Lody session is
authenticated, while failure exits non-zero with `{"ok":false,"error":"…"}`.

For a persistent failure, have the user run `lody login --debug` in their terminal for
login diagnostics, or use `lody daemon status` and `lody daemon logs -n 50` for runtime
diagnostics. Share only relevant, redacted errors. A running daemon alone does not prove
cloud authentication is healthy. `--skip-auth-check` skips a preflight; it does not fix
credentials or connectivity. If blocked, report the failing step and the user action
needed.

### Dispatch, waiting and completion

- Keep the returned session ID. If `create`/`chat --wait` times out or the connection
  drops, the prompt may already have been accepted. Inspect that session's `status`
  and `history`, then use `observe <id> --jsonl --follow` if it is still running.
- If no session ID was returned, use `session list` and inspect matching sessions
  before trying again. If acceptance remains uncertain, report that uncertainty;
  do not automatically resend. `create` and `chat` do not deduplicate retries.
- A runtime-not-running error calls for starting the runtime; a busy error calls for
  retrying later. Before retrying a write, establish whether it was accepted as above.
- Treat `turn.finished` as the end of that turn and inspect its `outcome` and reply.
  Idle/offline status alone is not completion. Report the session ID, result and
  remaining blockers instead of claiming success merely because waiting ended.

## Conventions

- **Workspace.** `--workspace <selector>` takes an id, slug or name; get them from
  `lody workspace list --json`. `schedule`, `automation` and the `agent-role` write
  commands also accept `-w`.
- **Other selectors.** `--agent-config`, `--machine`, `--agent-role` and MCP server names
  take an id or a name. An ambiguous name is rejected; retry with the id.
- **Output.** For automation prefer `--json`; streaming commands also have `--jsonl`.
  `--debug` prints diagnostic logs. `--offline` reads data already on this machine without
  syncing first. A failed `--json` command still exits non-zero and prints
  `{"ok":false,"error":"…"}`; check both the exit code and `ok`.
- **Paging.** The catalog lists (`machine`, `project`, `agent-config`, `agent-role`,
  `mcp list`) return 20 items by default.
  - Use `--limit 1-100` and `--query` to narrow results.
  - Use `--cursor` to get the next page, keeping the same filters. `--all-pages` fetches
    everything.
  - JSON output has the shape `{ items, hasMore, nextCursor? }`. Secrets are never included.
- **Safe retries.** Writes that take `--request-id <id>` are safe to retry: run the same
  id _with the same input_ again. These are schedule create/edit/pause/resume/run and
  agent-role create/update.
- **Prompts** for `session create`/`chat`:
  - Pass the text as an argument, with `--prompt`, with `--prompt-file <path|->`, or on
    stdin.
  - `--attach <path>` can be repeated: up to 8 non-empty files, at most 100 MiB each. If any
    attachment fails, nothing is sent.
  - Running the command again sends another message; it does not deduplicate.
- **`feedback`**: put options before the text. If the text starts with `-`, put `--` before
  it, or pipe the text with `--stdin`.

## What each command needs

| Also needs the Lody runtime on this machine | Needs only sign-in |
| ------------------------------------------- | ------------------ |
| `session create`, `session chat`, `session cancel` **targeting this machine** | The same commands **targeting another machine** (that machine must be online); `session list/history/show/status/observe/rename/archive/restore/delete` |
| `agent-config refresh-capabilities` (this machine only) | `workspace list/export/import`, `github list`, `machine list` |
| `project add/delete`, plain `project list` | `project list --workspace/--machine/--catalog`, `schedule *` |
| `agent-role create/update`, `automation *` | `agent-config` CRUD, `agent-role list/get`, `mcp *`, `sync`, `export` |
| `operation list` (operations recorded on this machine), `workspace reset-identity`, `dsh plugin` | `feedback` |

`app reset-cache`, `review` and `review prompt` need neither sign-in nor the runtime.
`machine pair --offer <cmd>` and `start --paired-workspace <account/workspace>` pair and
run a single encrypted workspace without account sign-in. Targeting another machine for
`session create`, `session chat` or `session cancel` still requires that machine online;
it does not require a local runtime. `agent-config import-magpie` requires sign-in and
this machine to be registered and online.

## Command reference

### Sign-in and runtime

- `login [--auth <credential>] [--machine-name <n>]`
  - With no options it signs in through the browser (device flow).
  - `--auth` takes a CLI API key or a machine connection token, for headless machines.
  - `logout` clears the saved sign-in.
- `start [--auth] [--machine-name] [--cli-types kimi grok claude codex] [--heartbeat-log] [--paired-workspace <account/workspace>]`
  runs the runtime in the foreground. Use it to watch live output, or pass
  `--paired-workspace` to run an already paired encrypted workspace without account login.
- `daemon start [--auth] [--machine-name] [--skip-auth-check]` runs the runtime in the
  background.
  - It first checks connectivity and sign-in. It asks you to sign in only in an
    interactive terminal.
  - `daemon stop|status|restart` manage it.
  - `daemon logs [-n 50]` shows recent logs; the files are under `~/.lody/logs`.
  - `daemon upgrade [--target-version <v>] [--channel stable|next|nightly] [--immediate] [--allow-channel-change] [--allow-downgrade]`
    prepares a checksummed managed daemon update and waits for idle by default; check
    progress with `daemon update-status [--request-id <id>]`.
  - `daemon install [--auth] [--start] [--autostart] [--replace]` installs the standalone
    SEA binary as a fixed managed service entry (not used by npm installations).
  - `daemon-runner` and other hidden commands exist only for the runtime's own use. Never
    run them.

### Sessions (`lody session …`)

`lody session` operates on one session per command (no batch subcommands; inside a Lody
session, use Lody's built-in MCP tools for batch creation, chat or status checks).

- `create [prompt]` starts a new session.
  - **Who runs it:** omit `--machine`/`--agent-config` to use this machine and the
    current session's config (or the machine's only config); otherwise pass
    `--machine` plus `--agent`/`--agent-config`, or an `--agent-role`.
    - A Role brings its own agent, mode, model and options (and its machine when it has a
      single target). With a single-target `--agent-role`, `--machine`, `--agent(-config)`,
      `--mode`, `--model` and `--config-option` are ignored with a warning. If the Role
      targets multiple machines, pass `--machine <machineId>` (or a target alias as
      `--agent-role`); `--machine` is required there and is not ignored.
  - **What it works on:** a GitHub repo `--repo owner/repo` _or_ a local project
    `--local-project <id|name|path>`, not both.
    - `--branch` picks the branch.
    - `--worktree` gives a `--local-project` session an isolated worktree so it does not
      touch your checkout.
  - **Parent:** `--parent <id>` or `--use-current-session-as-parent` makes it a child
    session and carries the parent's project, branch and machine.
  - **Per-turn options:**
    - `--mode` and `--model`
    - `--config-option k=v`, repeatable
    - `--mcp-server-ids '<json array>'`; `[]` turns off every MCP server (check
      `session create --help` on older CLIs).
  - `--title` fixes the title instead of letting Lody generate one.
  - `--env` is deprecated; set environment variables on the agent config.
  - **Waiting:** by default the command returns as soon as the message is sent.
    `--wait [--timeout <s>]` blocks until the agent's reply finishes.
- `chat [sessionId] [prompt]` sends a follow-up. It takes the same prompt, attachment,
  per-turn and wait options as `create`.
- `cancel [sessionId] [--turn-id <id>]` stops the running turn.
  - With `--turn-id` it cancels only if that exact turn is still running, so a newer turn
    is never stopped by mistake.
  - It exits non-zero on failure.
- `list` shows active sessions.
  - Filters: `--archived`, `--all`, `--query`, `--machine-id`, `--agent-config-id`,
    `--agent-role-id` (the Role the session was created from).
  - `--opened-by <id>` or `--opened-by-current` show sessions opened by a given session.
  - `--limit` caps the count.
- `history [id]` shows the visible conversation only, without reasoning or tool calls.
  Options: `--limit` (default 50), `--all`, `--reverse`, `--json`/`--jsonl`.
- `show [id]` prints session details. `status [id]` prints whether it is running now.
- `observe [id]` watches a session without marking it read.
  - By default it prints a snapshot. `--jsonl --follow` streams the events `snapshot`,
    `ready`, `session.changed`, `turn.started`, `turn.finished` and `session.removed`.
  - `turn.finished.outcome` is `completed`, `failed` or `canceled`.
  - `--workspace X --all` watches every session in a workspace; omit the id.
  - A session counting as idle or offline does not mean a turn finished. Wait for
    `turn.finished`.
- `rename [id] [title]` changes the title. Inside a session, use `--title` so the title is
  not mistaken for an id.
- `archive` hides a session. `restore` brings it back.
- `delete` permanently removes an archived session and cleans up its worktree on the
  machine.

### Schedules (`lody schedule …`)

A schedule sends a prompt to an agent on a set trigger. It always runs on the machine it
names, whichever machine created it.

Inside a Lody Agent session (`LODY_AGENT_SESSION_ID` set), `lody schedule` allows only
`list`, `show` and `pause`; `create`, `edit`, `resume`, `run` and `delete` fail because
schedule enablement requires a human action. From inside a session, use the Lody MCP tool
`lody_schedule_propose` to post a human confirmation card instead.

- `list [--query] [--limit 30] [--offset 0]` lists schedules.
- `show|pause|resume|run|delete <id>` act on one schedule. `run` starts it now.
- `create --file draft.json` and `edit <id> --file draft.json` take a JSON draft.
- `--every <step>` on `create`/`edit` fills the draft's `trigger` (omit `trigger` from the
  file): `90m`, `5h`, any whole number of minutes or hours up to 2147483647, the same steps
  the editor's Custom field and agent proposals accept (Android carries the step as a
  32-bit integer). A step that divides the hour (minutes) or the day (hours) runs on the
  clock in `--time-zone` (default: this device; pass the target machine's zone when it
  differs). Any other step runs every N from now. An `edit` with the same step keeps the
  stored trigger and its anchor.

Draft format (unknown fields are rejected):

```json
{
  "title": "Nightly triage",
  "prompt": "Triage new issues and summarize.",
  "machineId": "MACHINE_ID",
  "trigger": { "kind": "cron", "expression": "0 9 * * 1-5", "timeZone": "Asia/Shanghai" },
  "misfirePolicy": { "kind": "skip" },
  "overlapPolicy": "skip",
  "agent": { "agentConfigId": "CONFIG_ID" },
  "project": { "kind": "github", "repoFullName": "owner/repo", "branch": "main" },
  "destination": { "kind": "new_session" },
  "retryPolicy": { "dispatchMaxAttempts": 3, "dispatchMaxAgeMs": 3600000 }
}
```

- **`trigger`**, by `kind`:
  - `manual`: runs only on `schedule run`
  - `once {at}`: an ISO time
  - `interval {everyMs ≥ 60000, anchorAt}`: repeats at that period
  - `cron {expression, timeZone}`
- **`misfirePolicy.kind`** sets what happens to a run missed while the machine was off:
  `skip` drops it, `run_once` catches it up once.
- **`overlapPolicy`** sets what happens when a run is due while the previous one is still
  running: `skip` drops it, `queue_one` queues it.
- **`retryPolicy`** controls retries when a run fails to start: 1–5 attempts, and stop
  retrying after at most 24 h.
- **`agent`** can also set `modeId`, `modelId` and `configOptionValues`. Credentials go on
  the agent config, not here.
- **`project`** is optional; leave it out for a plain chat. The local form is
  `{ "kind": "local", "localProjectId", "branch"?, "useWorktree"? }`.
- **`destination`** says where each run's prompt goes:
  - `new_session` (default)
  - `own_session {epoch}`: one session reused by this schedule
  - `existing_session {sessionId}`

### Automations (`lody automation …`)

Automations run on this machine's daemon to wait for a JavaScript condition and resume a
session when it matches, or to configure per-session maintenance/recovery features. All
subcommands accept `-w/--workspace`, `--session` (defaults to `LODY_SESSION_ID`), `--json`
and `--debug`, and require the local runtime.

- `register --file <check.js> [--reason <text>] [--interval 30000] [--expires-at <iso|epochMs>]`
  registers a background condition check (`--interval` in ms, 1000–86400000).
- `list`, `show <id>`, `cancel <id>` inspect or cancel waits.
- `activities [--limit 50] [--before <cursorJson>]` lists delivery, recovery and
  maintenance activity.
- `settings` reads and `configure --file <settings.json>` updates per-session features
  (`recoverCapacity`, `archiveAfterMerge`, `compactWhenIdle`).

### Agent configs, Roles, MCP servers

- **Agent configs** say which agent runs, on which machine, with what environment and
  instructions.
  - `agent-config list|get <id>|show [idOrName]` read them.
    - `show` lists environment variable names only. `--show-secrets` reveals the values;
      never use it where output is shared.
    - Without an argument, `show` uses the current session's agent config.
  - `agent-config create --agent-type <t>` adds one. Optional flags:
    - `--machine`, `--name`, `--description`
    - `--env K=V…` or `--env-file`
    - `--prompt` or `--prompt-file`
    - `--title-config-option K=V…`
  - `agent-config update [idOrName]` edits one.
    - `--env`/`--env-file` merge into the existing variables; `--unset-env K` removes one.
    - `--description ""` and `--prompt ""` clear those fields.
    - `--clear-title-generation` resets title generation.
  - `agent-config delete [idOrName]` removes one.
  - `agent-config refresh-capabilities [idOrName] [--machine]` re-detects the agent's
    modes, models and options.
    - Run it after installing or upgrading an agent CLI, or after changing its environment.
    - It works only for this machine, and the machine must be online.
  - `agent-config import-magpie [--gateway <url> | --link <url>] [--targets <types>]`
    imports Magpie providers on this machine without a desktop confirmation dialog
    (requires this machine to be registered and online).
- **Roles** are reusable presets that combine an agent config with instructions.
  - `agent-role list|get <id>` read them.
  - `agent-role create|update` only **propose** a change. They require the local runtime,
    post a review card into the session (`--session` or the current session), and save
    nothing until a person clicks Save there.
  - `create` needs `--name`, `--machine-id` and `--agent-config-id`.
  - `update` needs at least one of `--name`, `--description`, `--prompt-prefix`. `""`
    clears a field.
  - `--file` takes JSON (camelCase field names) instead of the field flags; you cannot
    combine the two. For `update`, the file holds only the fields to change.
  - For long instructions: `--prompt-prefix "$(cat role.md)"`.
- **MCP servers** give sessions extra tools. Commands: `mcp list`, `mcp add <name>`,
  `mcp set <server>`, `mcp remove <server>`.
  - **Command servers (run as a process on the machine):**
    - `--command`, plus `--arg…` for its arguments
    - `--env NAME=${VAR}…` for environment variable references
    - `--env-passthrough NAME…` copies variables from the runtime's own environment on the
      target machine
  - **HTTP servers:**
    - `--url` (must not contain embedded username/password, fragment, or secret query keys)
    - `--bearer-token '${VAR}'`
    - `--header 'Name:${VAR}'…`
  - `--description` adds a note. `--default/--no-default` sets whether new sessions select
    the server automatically. `set --name` renames.
  - **No literal secrets in shared catalog entries:** `mcp add` and `mcp set` reject
    literal values in `--env`, `--bearer-token`, `--header` and credentialed URLs. Values
    must be exact `${VAR}` references (or use `--env-passthrough`); configure local
    secrets or OAuth credentials on the target machine in Lody settings.

### Workspace, machines, projects

- `workspace list` lists your workspaces.
  - `workspace export --out <file> [--workspace] [--offline]` exports a complete,
    re-importable workspace bundle (owners/admins; plaintext containing every conversation
    and attachment). `workspace import <file> [--workspace] [--dry-run] [--yes]` merges a
    bundle back into a workspace (owners/admins; `--yes` required when non-interactive).
    Both commands are on `main` and not yet in `lody@0.113.1`; check
    `lody workspace --help`.
  - `workspace reset-identity <workspace-id> --confirm [--reset-id <uuid>]` archives this
    machine's identity for an encrypted workspace and requires fresh approved pairing
    (needs the local runtime; reuse `--reset-id` on retry).
- `github list` lists the repositories linked to the workspace. That is not every
  repository the GitHub App can see.
- `machine list` lists machines. Filter by status with `--online-only` or
  `--online-status online|offline|unknown`; `unknown` does not mean offline.
  - `--include-acp-capabilities` and `--include-agents` are older detailed views and do not
    combine with paging or filter flags.
  - `machine pair --offer <command>` pairs this machine with one encrypted workspace using
    an expiring offer from the desktop app, then starts it with `--paired-workspace`. Do
    not echo offers in conversation or reuse an offer already claimed by another machine.
- **Projects** are directories Lody can open sessions in.
  - `project add [path=.] [--workspace | --all-workspaces]` registers one.
  - `project delete` works only in an interactive terminal, where you pick from a list.
  - `project list` shows this machine's projects.
    `--workspace/--machine/--kind local|github/--catalog` browses the workspace catalog.
- `dsh plugin <args...> [--agent-config <id>]` runs native `dsh plugin` commands in a
  local DSH Provider's profile (needs the local runtime; pass `--agent-config` when
  non-interactive; do not pass `--profile`).
- `operation list [--session] [--state active|finished]` shows operations recorded on this
  machine, such as git and PR actions.
- `sync [--workspace | --all-workspace] [--concurrency 4] [--json|--jsonl]` downloads
  workspace data to this machine.
- `export [outputDir] [--workspace | --all-workspace] [--no-images] [--offline]` writes
  sessions to local files.

### Desktop app and review

- `lody app [path=.] [--workspace]` opens the desktop app on a new chat with that directory
  selected, and registers the directory as a project.
- `app reset-cache [--hard | --cancel]` resets the app's cache the next time the app
  starts. `--hard` also erases local data and signs you out.
- `review [file] [-r repo] [-o out.html] [--no-open]` turns a `.review.md` or
  `.review.json[.gz]` file into a standalone HTML page.
- `review prompt` prints instructions that teach an agent to write a `.review.md`.

## Ask the user first

Confirm before running any of these:

- `session delete`, `agent-config delete`, `mcp remove`, `schedule delete`
- `mcp set`, which can replace a server's command, URL or credentials
- `agent-config update`, which changes a shared agent configuration, and
  `agent-config import-magpie`, which imports providers without a desktop prompt
- `project delete`, which removes a registered project
- `schedule edit`, which changes live automation, and `automation configure`/`cancel`,
  which change session automation state
- `workspace import`, `workspace export` (writes plaintext conversations and attachments),
  and `workspace reset-identity` (archives local encrypted-workspace identity)
- `app reset-cache --hard`
- `logout`
- `daemon stop`, `daemon restart`, `daemon upgrade --immediate`, and
  `daemon install --replace`, which interrupt running sessions or hosts

`session create`/`chat`, `schedule run` and `feedback` do real work or send data. None of
them is a dry run.
