# `@lody/ui`

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Base UI + StyleX component library that `packages/components/src/ui` migrates
into one component at a time. Source-consumed; consumers compile it through
`@stylexjs/unplugin` configured with `stylex-options.ts` from this package.

- No Tailwind. No `className` prop, no `cn`, no `cva`, no `tailwind-merge`, no
  `@source` scanning. Consumers customize through a `style` prop that takes a
  StyleX style object, and through `stylex.createTheme` on a subtree.
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
- `corner.shape` is applied wherever a radius is applied. Round corners outside
  Chromium are the accepted fallback.
- A Radix file in `packages/components/src/ui` is deleted when its in-repo
  callers reach zero; private consumers sync on typecheck.
