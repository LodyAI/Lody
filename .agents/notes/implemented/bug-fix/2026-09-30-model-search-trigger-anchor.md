# Trigger-anchored, content-sized model search

Status: implemented
Translation: current

[中文](2026-09-30-model-search-trigger-anchor.zh.md)

## Abstract

Attempts to prevent model-search movement first retained unfiltered height,
leaving blank space, then retained screen position, detaching short menus from
their trigger row. Both unmerged attempts were rejected by the user and removed.
Moving search below results also misread the request and was reverted. Search
stays above results; the panel lifts one search-header height so options start
beside the Model row. Current-result sizing and viewport collision handling remain;
filtering can move search as the popup realigns. Packaged Electron acceptance remains unverified.

## Decision and rejected alternatives

This consolidates the unmerged search experiments without replacing the
[cascading submenu decision](2026-09-30-composer-cascading-submenu-placement.md).
The [draft Spec](../../../../specs/composer-run-config-submenu-placement.md)
requires the Model-row anchor during filtering, not an immutable screen
coordinate for search.

Reserving the measured unfiltered footprint kept search stationary but left a
328px panel for one result. Replacing height retention with an alignment offset
and `sticky` shrank the panel to 68px but left it at y=384, ending at y=452 above
the Model row at y=540. That detached popup was also rejected. Neither behavior
is an accepted design guarantee.

All query-origin, query-dependent offset, sticky, and retained-dimension code was removed.
[`MenuOptionSearchList`](../../../../packages/components/src/components/shared/menu-option-search-list.tsx)
stays content-sized with search above results. A bottom-search attempt misread
the requested upward placement and was reverted, including its unused primitive
API and style. The
[desktop host](../../../../packages/components/src/components/sessions/desktop-run-config-menu.tsx)
still caps actual model content at 20rem and the available height. Searchable
panels use a constant -32px alignment offset (28px field + 4px gap), so the option
area starts beside the Model row when space permits. The offset depends on the
unfiltered catalog's search threshold, not the query; short menus retain zero.
Unlike the rejected retained-origin attempt, positioning still recalculates from
the live trigger and current size. Only options scroll; search remains visible,
and filtering may change its screen coordinate.
Current implementation details belong in [composer run config](../../../docs/sessions-run-config.md).

## Verification and limits

Playwright Chromium uses real menu/search components, synthetic catalogs, and
a synthetic frame matching the desktop shell's 8px bottom inset. At 1040×720,
33 models occupy a 232×328 popup at y=384–712. With all six selector rows present,
filtering to one result or no results produces a 232×68 popup at y=480–548.
The search field spans y=484–512, above the Model row at y=512. For one result,
the option spans y=516–544, matching the shared 4px popup inset beside the row.
Clearing restores the full list and its capped height.

Checks cover successive query edits, natural shrink, row anchoring, empty
results, clearing, 6/10/33-model catalogs, long names, horizontal flipping,
hover/click opening, keyboard typing and selection, scrolling, and low viewports.
The upward-placement comparison uses a snapshot of the preceding row-aligned input
and the corrected source, covering full, single-result, and empty lists. Fixtures/screenshots stay ignored
and contain only synthetic data.

The owning [browser suite](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
asserts current-size option-area alignment, viewport bounds, and top-search order rather
than frozen screen geometry. The isolated Playwright checks also verify the top
field remains visible during scrolling and ArrowUp/ArrowDown navigation. The
run-config face, fuzzy-filter, and dropdown-menu suites passed 24 tests; source
formatting and lint passed. The composer-model-search suite could not collect:
its imported ACP capability constant is absent from the borrowed dependencies.
Full Storybook/component typecheck remains blocked
by missing Electron/ACP modules and stale borrowed dependencies. In the isolated
fixture, keyboard opening initially focuses the selected row in both versions;
typing routes focus to search. Automatic-focus and packaged Electron acceptance
are not established by this fixture.

The pre-commit root `pnpm format` passed. Root `pnpm check` stopped in
`packages/ignore` typecheck because local Node, Effect, and Vitest dependencies
were missing; subsequent root check stages did not run. Documentation validation
reported 62 broken links, all targeting absent ACP submodule files, with no
errors in changed documents and no protected topics.
