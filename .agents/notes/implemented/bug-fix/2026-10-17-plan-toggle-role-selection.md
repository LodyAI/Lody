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
memory retention, navigation, and explicit None. All 40 tests in the three owning
suites pass, as does components typecheck. Scoped lint has no errors (two existing
nullable-string warnings); docs check passes with existing size warnings. Full
`pnpm check` passed typecheck, lint, Effect lint and script tests, then stopped at
the unchanged CLI recursive SSH submodule test with `context_unreadable` (4,310
CLI tests passed, one failed, four skipped). Later stages did not run.
`pnpm format` passed. Packaged UI acceptance has not been performed.
