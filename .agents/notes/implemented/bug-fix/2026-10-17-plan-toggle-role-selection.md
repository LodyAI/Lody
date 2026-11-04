# Preserve Role selection across independent Plan toggles

Status: implemented
Translation: current

[中文](2026-10-17-plan-toggle-role-selection.zh.md)

## Abstract

Turning off Codex Plan detached the selected Role because the composer compared
all saved options exactly. The same comparison also cleared Role metadata when
executing a proposed plan. Independent Plan now acts as a per-turn override of
the Role's initial value, preserving identity and memory. Model, reasoning,
permission, and binding checks remain strict, including permission-based Plan.

## Decision and ownership

`composer-agent-roles.ts` owns matching for landing, existing sessions, and final
programmatic Turn overrides. Accept differing valid booleans for `plan_mode`, and
valid default/plan values for legacy `collaboration_mode`. Missing or invalid
values remain mismatches, so schema fallback cannot silently preserve a broken
preset. Re-selecting a Role still applies its saved Plan value; neither the
catalog nor creation provenance is rewritten. The actual Turn config remains
the dispatch authority, while the snapshot records the selected preset.

Keeping exact Plan equality would require re-selection and restore the very
Plan value the user just disabled. Broadly ignoring every option would hide
model or permission drift, so this change is limited to independent Plan.
The existing [run-config explanation](../../../docs/sessions-run-config.md)
now records this exception to its strict pin-matching rule.

## Verification

Regression coverage extends the existing matcher and hook suites: both Plan
representations, execute-plan metadata, missing/invalid values, other pin drift,
memory retention, navigation, and explicit None. All 44 tests in the three owning
suites pass, as does components typecheck. Scoped lint has no errors (two existing
nullable-string warnings); docs check passes with existing size warnings. Full
`pnpm check` passed typecheck, lint, Effect lint and script tests, then stopped at
the unchanged CLI recursive SSH submodule test with `context_unreadable` (4,310
CLI tests passed, one failed, four skipped). Later stages did not run.
`pnpm format` passed. Packaged UI acceptance has not been performed.

## Ablation evidence

Seven one-at-a-time deletions were tested against the three owning suites,
restoring the source after each run. The initial 40-test baseline passed.

| Deleted behavior | Failing tests |
| --- | ---: |
| Boolean Plan exception | 4 |
| Legacy Plan exception | 3 |
| Current boolean value validation | 2 |
| Current legacy value validation | 2 |
| Other pinned-option comparison | 8 |
| Saved boolean value validation | 0 initially; 2 after coverage repair |
| Saved legacy value validation | 0 initially; 2 after coverage repair |

The two surviving deletions exposed missing coverage, not redundant validation:
Role option normalization preserves strings and booleans without validating their
Plan semantics. Four cases now verify that invalid stored Plan values cannot
retain the Role merely because the composer has a valid value. With those cases,
the intact baseline passes 44 tests and each formerly surviving deletion fails
two tests. No production branch was removed: this bounded experiment provides
no evidence that the new matching guards are redundant. Mutation scripts and
logs remain temporary, outside the repository.
