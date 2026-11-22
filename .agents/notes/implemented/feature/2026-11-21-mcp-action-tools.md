# Lody MCP action tools and the Session PR link guidance

Status: implemented
Translation: current

[中文](2026-11-21-mcp-action-tools.zh.md)

## Abstract

Every Agent that Lody starts loads the whole Lody MCP tool list, and clients that do
not defer schemas pay for it on every turn. After single/batch and get/list pairs were
merged (40 to 30 tools), the owner approved turning low-frequency families into action
tools whose eager schema is only an `action` enum and an `arguments` object, with the
per-action detail served by `lody_help`. That gives 21 tools and 27,769 bytes. Reads stay
in read-only tools, so this costs two tools more than the design's estimate of about 19.
The same change gives agents `pr_link` / `pr_unlink` / `pr_list` for their own Session,
plus one owner-approved prompt sentence for git working directories, worded by
whether the Session's managed `gh` shim already links PRs. Whether agents
follow that sentence, or read action help as reliably as full schemas, is unmeasured.

## Decision

- **Action tools.** `lody_session_manage` (rename, archive, share, `pr_link`,
  `pr_unlink`, `pr_list`), `lody_schedule` (propose, pause), `lody_agent_role`
  (create, update), `lody_operation` (get, batch, list) and `lody_catalog`
  (machines, projects, mcp_servers, agent_configs, agent_roles, schedules). Each
  action keeps its previous schema as the validator of `arguments`. High-frequency
  tools keep full eager schemas.
- **Reads stay auto-approvable.** Clients may auto-approve tools marked
  `readOnlyHint`, and one tool's annotation covers every action. Merging Role and
  Schedule reads into their write families, or cancel into `lody_operation`, would
  drop the hint from those reads. So reads are in `lody_catalog` and `lody_operation`
  (both read-only), and `lody_operation_cancel` stays a separate tool.
  `pr_list` is the one read inside a mutating tool. `lody_mcp_configure` stays
  separate as an execution and credential boundary.
- **Execution placement.** `share` and catalog `schedules` run in the MCP process
  that received the call (`executeLocally`), as their tools did before. The daemon
  rejects them over IPC. Every other action uses the daemon Session tool route.
- **PR links.** `pr_*` act only on the calling Session from the MCP session context;
  no argument can name another Session. They call `lib/session-pr-links.ts` with
  source `agent` ([explicit links](2026-11-21-session-explicit-pr-links.md)).
- **Standing guidance, one sentence per surface (owner-approved 2026-11-21, only
  when the working directory has git).**
  - Per-prompt Lody tools reminder, one sentence per Session. The owner approved
    both variants on 2026-11-21:
    - With the managed `gh` shim on the Session's PATH, `gh pr create` already
      links its PR, so `LODY_PR_LINK_GUIDANCE` covers the other paths: "A pull or
      merge request this Session opened without gh pr create is linked to it with
      lody_session_manage action pr_link."
    - Without the shim (local projects on native credentials), `gh pr create`
      links nothing, so `LODY_PR_LINK_GUIDANCE_WITHOUT_GH_SHIM` covers every PR:
      "A pull or merge request this Session opens is linked to it with
      lody_session_manage action pr_link."
  - The variant follows the same fact that puts the shim on PATH, managed broker
    credentials (`session.getGitHubCredentials().mode === 'managed'`), not the
    project kind. The sentence is added when the project is a GitHub project or the
    working directory contains `.git` (a stat, not a git process). Both constants
    are in `apps/cli/src/mcp/tool-help.ts`.
  - The `gh` shim's "not linked" stderr line names `lody_session_manage` action
    `pr_link`.

## Alternatives

- Moving low-frequency capabilities to the `lody` CLI was rejected by the owner:
  the lody-cli skill is not injected into Lody-started Agents.
- Dynamic tool lists and a search/execute meta-tool were rejected in the merge step:
  some clients ignore list changes, a changing list breaks prompt caches, and one
  execute tool loses per-tool permissions and annotations.
- Folding every family exactly as first designed (about 19 tools) was not chosen
  because of the read-only cost above.

## Measurements

The tool list was read with an in-memory MCP client against `buildLodyMcpServer()`
on Linux; iOS preview is absent there.

| Revision | Tools | `tools/list` bytes |
| --- | --- | --- |
| main 0f24fb82c | 40 | 51,355 |
| merged pairs (#3022) | 30 | 35,596 |
| action tools | 21 | 27,769 |

## Verification

- `apps/cli/src/mcp/tool-help.test.ts`: thin eager schema, per-action help and
  validation of real arguments.
- `apps/cli/src/mcp/lody-mcp-server.test.ts`: exact tool names and the read-only set.
- `apps/cli/src/mcp/daemon-session-tools.test.ts`: `pr_link`, `pr_list` and
  `pr_unlink` act on the calling Session as agent records; `share` never runs over IPC.
- `apps/cli/tests/session-execution-helpers.test.ts` (each variant, none without git) and
  `apps/cli/tests/gh-shim-script.test.ts` (stderr line).
- Not verified: agent compliance in a live provider session.
