# Preserve Claude plans after rejecting execution

Status: implemented
Translation: current

[中文](2026-10-22-claude-rejected-plan-display.zh.md)

## Abstract

Claude plan approval stores the plan in both tool content and `rawInput.plan`. Rejecting execution replaces tool content with a rejection message, and Lody displays that message as the plan because its resolver prefers content. The original plan remains in raw input in the repository scenario. The resolver now prefers explicit plan input and retains content as a fallback for adapters that only provide content. This restores existing stored cards without a data migration or adapter runtime release.

## Evidence and scope

- Claude `ExitPlanModeReporter.errorResult` only suppresses display output for AIR clients. Lody does not advertise AIR; the generic error renderer supplies replacement content.
- Shared `mergeToolCallMessage` correctly treats ACP content as replacement and retains raw input when the result omits it. Changing generic merge semantics would break other tool results.
- Before the fix, `resolvePlanExitMarkdown` read the first content text before `rawInput.plan`, so the replacement rejection text masked the retained plan.
- The checked-in Claude `src/tests/acp-scenarios/__snapshots__/v2/exit-plan-reject.jsonl` synthetic scenario reproduces this payload sequence. A Node assertion using the actual UI resolver confirms the initial plan resolves correctly, raw input retains it after the result, and the resolver then returns rejection text.

## Implementation and validation

The shared plan resolver reads nonempty string `rawInput.plan` before tool content. The first nonempty content block remains the fallback for content-only plans; invalid or blank raw plan values cannot suppress it. Separate Codex plan rows still own their display. No generic history merge or adapter changes are needed. An adapter-side fix alone would require a runtime release and would not repair existing stored cards.

The existing plan-surface suite covers replaced content after rejection or approval, historical JSON hydration, empty replacement content, malformed raw plans, Kimi's trailing action summary, and separate-plan/pending-decision helpers. Both replacement regressions fail before the fix; all 19 tests pass after it. The existing denied-plan Storybook fixture now models Claude's failed status, retained plan input, and replaced error content.

Tests ran with Vitest 3.2.4 and a temporary Node-only configuration because this checkout has no installed workspace dependencies. Full package type checking and UI/Storybook execution remain unverified; the host Node 22.20.0 is below the repository floor. Documentation checking reports pre-existing missing-submodule links, with no errors in the new note pair. No live user session was read.
