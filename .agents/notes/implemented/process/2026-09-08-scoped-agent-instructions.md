# Scope agent instructions to the work that needs them

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/473

English | [中文](2026-09-08-scoped-agent-instructions.zh.md)

## Abstract

Large ancestor instruction files made unrelated changes load detailed feature
contracts: the chat/submission ancestor chain alone contained 36,226 bytes.
This change keeps global boundaries and documentation obligations visible while
moving platform, catalog, MCP-handler, and file-helper contracts to their owning
`AGENTS.md` files with explicit caller-facing read triggers. That chain now contains
27,409 bytes, excluding conditional topic reads. Product guarantees and review
severity are preserved; the trade-off is that cross-directory work must follow
the required topic links, so smaller ancestor files are not proof of lower total
reading cost for every task.

## Decision and relation to earlier work

This implements instruction placement and editorial simplification, not a change
to product intent. It extends the routing described in the
[maintenance proposal](../../proposed/process/2026-09-05-human-reviewed-spec-maintenance.md)
without approving that whole proposal or any Spec. It preserves the directly
visible Spec/Note obligations established by
[explicit note triggers](2026-09-07-explicit-agent-note-triggers.md).

Binding rules still live in `AGENTS.md`, with explanations in `.agents/docs/`.
For contracts spanning directories, the common ancestor names the behavior that
requires reading the owner, including UI/CLI consumers outside its directory.
Existing UI geometry, consent, durability, privacy, and P0/P1 review requirements
are retained. There is no new approval gate, generated index, or runtime change.

## Ownership and coverage review

| Previous home and content | Current home | How other callers reach it |
| --- | --- | --- |
| Root: composition, settings capabilities, telemetry, runtime channel | [platform rules](../../../../packages/platform/AGENTS.md) | Root requires reading them before changes to those behaviors; global public/local boundaries remain in root. |
| Root: protocol negotiation, MCP selection, catalog durability, Role security/dispatch | [shared rules](../../../../packages/shared/AGENTS.md) | Root trigger includes catalog UI consumers, per-turn selection, and Role creation/dispatch. The original contracts are retained. |
| Root: viewer release version | [existing viewer rules](../../../../packages/code-review-viewer/AGENTS.md) | Root routes packaging/version changes to the existing, more detailed definition. |
| Root: community size/assignment details | [existing GitHub rules](../../../../.github/AGENTS.md) | Root still resolves identity and requires these rules before planning community work, as well as before PR/Issue work. |
| CLI: Session/Task MCP tools | [MCP rules](../../../../apps/cli/src/mcp/AGENTS.md) | CLI requires reading them for tools, callers, and delegated Task automation; child Session provenance, model validation, and feedback privacy remain in the CLI parent. |
| Components package: crash recovery, file preview, Code Collab | [helper rules](../../../../packages/components/src/lib/AGENTS.md) | Package trigger explicitly covers UI, hooks, providers, caches, diagnostics, and IPC callers. |
| Helper rules: IPC/path explanations and known gaps | [file identity explanation](../../../docs/components-file-paths.md) | Binding constraints stay in helper rules, including cache aliases, errors, and skipped-directory/readonly repair constraints. |
| Chat: composer and selector wording | [chat rules](../../../../packages/components/src/components/chat/AGENTS.md) | Same scope; behavior, thresholds, draft ownership, menu interactions, and platform distinctions remain explicit. |

New platform/shared scopes each have a `CLAUDE.md -> AGENTS.md` symlink.
The maintenance guide now explains required-read triggers and ancestor-chain
measurement. Related CLI and component explanations point to the new owners.

## Measurements and alternatives

Byte counts use Git-managed baseline `AGENTS.md` files and current non-ignored
files, counting each once without its `CLAUDE.md` alias. An ancestor-chain count
sums the root and each ancestor `AGENTS.md` of the named source directory.

| Scope | Before | After |
| --- | ---: | ---: |
| Root | 7,983 | 5,046 |
| CLI parent | 8,151 | 5,610 |
| Components parent | 7,641 | 2,956 |
| Chat | 8,183 | 6,988 |
| CLI `src/session/worktree/` ancestor chain | 28,059 | 22,581 |
| Components `src/components/chat/submission/` ancestor chain | 36,226 | 27,409 |
| All `AGENTS.md` files, including new owners | 302,390 | 298,195 |
| Files over the existing 7,000-byte warning threshold | 21 | 17 |

Moving a contract does not remove its reading duty: a Role-related composer task
also reads shared contracts, and a file-surface task reads helper rules. These
figures do not measure model tokens, runtime performance, or agent success rates.

Only shortening sentences would leave unrelated contracts in ancestor chains.
Moving binding rules into historical notes would lose reliable discovery. This
change uses scoped ownership plus required reads; a wider policy deletion or a
new cumulative-size gate remains outside this change. Remaining large scopes
retain their current rules rather than being split solely to meet a byte target.

## Validation and limits

- Compared relocated root/MCP contracts and edited component/chat rules against
  the base diff, including explicit empty MCP selection, Role freezing, consent,
  local-only file routes, binary cache exclusion, and recovery boundaries.
- `pnpm run docs status`, `pnpm run docs check`, and `git diff --check` pass;
  17 pre-existing size warnings remain and there are no registered SHA topics.
- `pnpm check:public-boundary` fails on eight unresolved ACP workspace dependency
  references. An isolated export of the unchanged HEAD, indexed in a temporary Git
  repository, produces the same eight failures. This checkout lacks the referenced
  submodule manifests; the documentation changes add no boundary finding.
- During PR preparation, `pnpm check` was attempted and stopped at typecheck because
  `tsgo` is missing; later lint/test stages did not run. `pnpm format` completed;
  its unrelated source-formatting changes were restored before committing.
- No application source, package manifests, or dependencies changed. Full application
  type/build/test validation remains incomplete; no claim of product correctness or
  Spec approval follows from this documentation validation.
