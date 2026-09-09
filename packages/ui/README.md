# `@lody/ui`

`@lody/ui` contains Lody's low-level visual primitives and semantic StyleX
tokens. Product surfaces compose these primitives through
`@lody/components`; the package does not contain product workflows or platform
behavior.

| Area                | Responsibility                                                      |
| ------------------- | ------------------------------------------------------------------- |
| `src/tokens`        | Semantic color, type, spacing, motion, radius, and elevation tokens |
| `src/theme`         | Applies light or dark StyleX themes to a subtree                    |
| `src/button`        | Base UI Button behavior and Lody variants, sizes, tones, and shapes |
| `stylex-options.ts` | Shared compiler configuration for source-consuming hosts            |

Consumers compile this package's source with `@stylexjs/unplugin` and its exported
StyleX options. Visual choices use component props. `className` is available for
layout and interaction constraints in product surfaces; it must not duplicate a
primitive's visual rules.

The intended behavior is specified in [Shared UI primitives](../../specs/ui-primitives.md).
The integration decision is recorded in the
[UI Button migration takeover note](../../.agents/notes/implemented/architecture/2026-09-08-ui-button-migration-takeover.md).

Run `pnpm --filter @lody/ui typecheck` and `pnpm --filter @lody/ui test` after
changing a primitive or token.
