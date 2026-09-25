# UI Button migration takeover

Status: implemented
Translation: pending
Issue: https://github.com/LodyAI/Lody/issues/304
Original PR: https://github.com/LodyAI/Lody/pull/305

## Abstract

PR #305 redesigns Lody buttons around `@lody/ui`, Base UI, and StyleX tokens,
but its September 2 branch no longer merged cleanly with current `main`. The
takeover keeps that redesign as the visual authority, preserves business behavior
added on `main`, and migrates newer Button consumers to the author's public API.
It does not provide a compatibility layer for the deleted Button or restore its
appearance through caller classes. Surface-specific accessibility and layout
requirements remain explicit at their owning call sites.

## Decision

Update the author's branch by merging current `main` into its existing commit.
Resolve overlapping product files by retaining current navigation, session,
onboarding, machine, and Skills behavior, then express their controls using the
new Button variants, sizes, tones, shapes, and icon flag.

New Button consumers added after the PR base follow the same API used by the
author's migration. They do not select sizes by matching the removed component's
pixel dimensions. Mermaid viewer controls keep their existing 44 px touch target
because that surface has an independent mobile accessibility requirement; the
new Button still owns their appearance.

`@lody/ui` owns primitive visuals and semantic tokens. Product packages compose
those primitives and may pass classes for layout or interaction constraints.
Caller classes must not recreate the deleted Button's colors, typography,
shadows, radii, or state styling.

Composer submit and stop actions use the Button's `primary`, `medium`, `pill`,
and icon choices directly. Their former `ghost` variant plus Tailwind color,
size, radius, shadow, and press-state overrides bypassed the primitive and could
leave the stop glyph with insufficient contrast. Landing, session, mobile-sheet,
and Storybook compositions now select the same token-owned control treatment.

## Integration evidence

The original PR is commit `11ef421f86c29fe50773c6c101bf129839368c3c`,
based on `947affd0741e35b3644622c841e8457a26133a95`. Current `main` is merged as
the second parent so the author's commit and authorship remain intact. Conflict
resolution retains the current package dependencies and application handlers,
adds `@lody/ui` where needed, and regenerates the lockfile from the merged
manifests.

Verification used the repository's supported Node 22 runtime. The complete
`pnpm check` suite passed after disabling commit signing for its synthetic Git
repository, and the focused `@lody/ui` test suite passed all eight tests. The
Electron application, documentation site, and component Storybook production
builds completed with StyleX compiling the package source. A source scan found no
remaining imports of the deleted Button module or uses of its old size and variant
props.

Interactive browser screenshot comparison was unavailable in the takeover
environment. The production application and Storybook builds provide compiler
and integration coverage, but a maintainer should still inspect the PR preview as
the final visual acceptance step.

## Limits

This migration establishes the Button and token foundation described in the
linked draft Spec. Other primitives remain in `@lody/components` until a later
migration gives each one an explicit `@lody/ui` contract.
