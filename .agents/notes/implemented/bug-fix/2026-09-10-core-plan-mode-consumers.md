# Align Plan consumers with ACP Core

Status: implemented
Translation: pending

## Abstract

Codex's adapter advertised Core's boolean `plan_mode`, but Lody still recognized
only the older `collaboration_mode` select. The option survived parsing and was
classified as an ordinary boolean, which the desktop run menu did not display.
Capability discovery, static defaults, toggles, and plan-decision helpers now
understand the Core contract across Codex, Grok, Kimi and DeepSeek Harness.
Legacy select support remains for older agents;
independent planning never changes permission policy.

## Decision and evidence

Core owns the field identity and option factory. Shared static builtin capabilities
use that factory rather than duplicating its schema. Semantic dispatch prefers
the Core boolean if both generations are advertised, while legacy-only agents
continue receiving `default`/`plan`. Runtime snapshots remain authoritative; no
stored history or capability cache is rewritten.

The static Grok and Kimi selectors also needed migration: Grok now exposes Plan
plus Ask/Always Approve, matching its wrapper; Kimi exposes `permission_mode`
with Default/Auto/YOLO and a separate Plan boolean. Their legacy ACP modes remain
available as protocol metadata, but are not used to build the modern permission
selector. Claude retains its existing permission-based Plan behavior.
DeepSeek's builtin profile includes `dsh-plan-mode`, so preflight may offer Plan;
the actual session capability snapshot remains authoritative if the service is
absent. Cross-provider regressions cover both the static entry and runtime omission.

Changing only selector classification would leave UI toggles sending strings to
a boolean field. The fix therefore includes value resolution and the helper that
disables planning before implementation. Shared and component regression suites
cover Core capability discovery, dispatch, selector projection, toggling and
preservation of permission values, alongside the existing legacy cases.

The execution-turn override also handles boolean Plan snapshots, including an
unseeded draft whose runtime current value is true. It freezes `plan_mode: false`
for the new execution turn without editing the original draft or permission mode.

## Verification

Shared capability and component selector/UI/plan-decision/execution-turn suites
pass. Shared and component TypeScript checks pass. These checks exercise synthetic
contracts and rendered controls; the running desktop/daemon was not rebuilt or
restarted as part of this branch change.

Before PR creation, `pnpm format` completed; unrelated formatting was excluded.
The full `pnpm check` stopped during Claude adapter preparation because this
worktree lacks its dependencies (`@tsconfig/node22`, ACP and Anthropic SDKs),
before reaching the repository-wide test suite. Documentation and public-boundary
checks pass after initializing the pinned submodules.

The cross-provider follow-up passes 112 focused tests across builtin capability,
run-config, selector, UI, and execution-turn suites, plus the shared TypeScript
check. It preserves Claude's existing permission-based planning. PR:
[#566](https://github.com/LodyAI/Lody/pull/566).

See [composer run config](../../../docs/sessions-run-config.md) and the
[cache compatibility intent](../../../../specs/acp-capability-cache-compatibility.md).
This repair implements the existing Core contract rather than changing its intent.
