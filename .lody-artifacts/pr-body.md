## Related issue

Same-repository improvement; no linked issue.

## Problem / pressure

MCP-created conversations and child Tabs were only discoverable from the parent conversation after the creating Operation completed. Long-running child work therefore had no immediate navigation card or visible progress.

## Summary

- Publish a stable, UI-only `operation_progress` system row once each create target is materialized, and update its exact target Turn status in place.
- Render navigable cards with Created, Running, Completed successfully, Failed, and Cancelled states; batch targets update independently.
- Preserve existing completion delivery and legacy completion cards, while linking new completions to their progress row to avoid duplicate target cards.
- Keep progress out of agent replay/dispatch, preserve terminal state against stale updates, and make presentation writes independent of lifecycle success.
- Add English/Chinese copy, deterministic regression coverage, and Storybook stories for all five states.

## Before / after

| Before | After |
| ------ | ----- |
| No child card until the Operation finishes | Card and View session button as soon as the target exists |
| Creation-only label | In-place status updates for the creating target Turn |
| Batch visibility waits for all results | Each materialized target appears and updates independently |

## Test plan

- `pnpm check` passed (typechecks, lint, tests, i18n and repository boundary checks).
- Final refinements were rechecked with 91 CLI/MCP tests, 32 component tests, 3 shared-schema tests, affected typechecks, and `pnpm check:quick`.
- `pnpm format` passed; unrelated pre-existing Electron formatting was left unchanged.
- Components regression tests cover immediate navigation, in-place status updates, batch targets, stream cache invalidation, and completion deduplication.
- Playwright captured actual Storybook components in Chinese light/dark themes and a narrow viewport using synthetic fixtures. Stories: `Sessions/SessionRelationCard/{Created,Running,Succeeded,Failed,Cancelled,AllCreationStates}`.
- Real authenticated cross-machine end-to-end creation was not exercised against the modified daemon; coordinator tests use deterministic target and history evidence.

## Context handoff

<!-- context-handoff:begin -->

### Instructions for reviewing agents

- **Review focus:** Check `operation-progress-history.ts`, coordinator reconciliation, and MCP materialization for stable target identity, progress durability, and lifecycle isolation.
- **Decisions to challenge:** Progress is presentation-only system history; completion still owns the sole agent continuation and uses an optional progress link for UI deduplication.
- **Plausible failures / evidence gaps:** Pay attention to stale batch snapshots, cancellation before materialization, and terminal progress while the requester is busy; live cross-machine integration was not run.

### Authoring context

- **User goal / directives:** Make newly created child conversations immediately reachable and display changing execution state, with screenshots and a PR.
- **Constraints / non-goals:** Preserve execution permissions, Operation acceptance, completion scheduling, local/cloud boundaries, and unrelated changes.
- **Risk-bearing decisions:** Target status is bound to the exact creating Turn rather than later Session activity; terminal progress cannot regress to an active state.
- **Destructive or irreversible behavior:** No destructive actions, data migration, or lifecycle rollback is introduced; progress writes only add or update their own stable history row.
- **Deliberately not done or tested:** No production credentials or live cross-machine agent work were used for visual verification; synthetic Storybook fixtures and coordinator tests provide bounded evidence.
- **Unknowns / confidence:** Static and deterministic regression checks passed; deployed cross-machine timing remains an integration verification gap.

<!-- context-handoff:end -->
