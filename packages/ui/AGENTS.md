# `@lody/ui`

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Base UI + StyleX component library that `packages/components/src/ui` migrates
into one component at a time. Source-consumed; consumers compile it through
`@stylexjs/unplugin` configured with `stylex-options.ts` from this package.

- Package styles use StyleX: no Tailwind, `cn`, `cva`, `tailwind-merge`, or
  `@source` scanning inside this package. Component props own visual variants,
  sizes, tones, and shapes. A plain `className` pass-through may carry caller
  layout or interaction constraints during staged migration; do not use it to
  reconstruct the deleted component's visual design.
- Depends on React, `@base-ui/react` and `@stylexjs/stylex` only. Never on
  `@lody/components`, `@lody/platform`, or any cloud package.
- No border token exists. Edges are wells, raised shadows, elevation shadows
  and the focus ring. See `src/tokens/RULES.md` before adding a token or a
  component style.
- Files that call `defineVars`, `createTheme` or `defineConsts` end in
  `.stylex.ts`. Their arguments are object literals; the compiler cannot
  evaluate helpers. Vars are imported from that file by a specifier ending in
  `.stylex` (`@lody/ui/tokens/colors.stylex`), never through a barrel.
- Component tokens live beside the component as
  `<name>/<name>.tokens.stylex.ts` and reference semantic tokens or literal px.
  A component token that points at a semantic colour also belongs in that file's
  `createTheme` palette theme, which `ThemeRoot` applies with every forced
  palette; a custom property declared only at the document root keeps the root
  palette inside a themed subtree.
- `src/gallery` is the visual reference for the package. A new token, variant,
  size, tone or shape lands with its board entry in the same change, and the
  board reads sample values back off the rendered node instead of repeating a
  literal. `test/gallery.test.tsx` fails when a token has no entry.
- `corner.shape` is applied wherever a radius is applied. Round corners outside
  Chromium are the accepted fallback.
- A Radix file in `packages/components/src/ui` is deleted when its in-repo
  callers reach zero; private consumers sync on typecheck.
