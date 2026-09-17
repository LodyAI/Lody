# Extract the icon system into `@lody/icons`

Status: implemented
Translation: pending

## Abstract

The icon system is now an independently consumable workspace package. The
extraction removes its implementation dependencies on `@lody/ui` while keeping
the old UI subpath available during caller migration.

## Decision

The original Lody icon registry, SVG renderer, four visual treatments, and
stateful icons now live in the independent `@lody/icons` workspace package.
`@lody/ui` depends on `@lody/icons`; the icon package does not depend on
`@lody/ui`, Base UI, product components, or UI token modules.

The old `@lody/ui/icons` subpath remains a compatibility re-export so existing
consumers do not need a flag-day import change. New code and the icon playground
use `@lody/icons` directly. The legacy `src/internal/glyphs.tsx` primitives
remain in `@lody/ui` because they are private marks owned by its controls, not
members of the independent icon set.

## Implementation

- Moved the icon registry, renderer, stateful icons, icon-specific rules, and
  tests from `packages/ui` to `packages/icons`.
- Replaced the renderer's dependency on `@lody/ui/internal/class-name` with a
  local helper.
- Replaced the stateful renderer's dependency on `@lody/ui` motion tokens with
  its own fixed transition contract.
- Added public root and focused subpath exports to `@lody/icons` and added its
  workspace importer and lockfile entry.
- Updated the existing icon playground to consume the new package and emit
  `@lody/icons` examples.

## Validation

- `pnpm --filter @lody/icons typecheck`
- `pnpm --filter @lody/icons test` — 18 tests passed
- `pnpm --filter @lody/ui typecheck`
- `pnpm --filter @lody/ui test` — 258 tests passed

The package extraction implements the boundary proposed in
`.agents/notes/proposed/feature/2026-09-14-ui-icon-set.md`; product-wide
migration from `lucide-react` and other product-local icons remains separate
work.
