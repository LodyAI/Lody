# Icons

Root, `packages/components/AGENTS.md`, and `src/AGENTS.md` also apply.
`CLAUDE.md` is a symlink to this file; edit `AGENTS.md` only.

- Raw registry SVG markup renders through `inline-svg.tsx`, never a local
  `dangerouslySetInnerHTML={{ __html: raw }}`. React 19 compares that prop by
  object identity and then assigns `innerHTML` unconditionally — unlike React 18
  it no longer compares the markup — so a fresh literal per render reparses the
  same SVG and replaces the live node. `InlineSvg` interns the wrapper per markup
  string, which is what keeps an unchanged icon off the mutation path when a
  session switch re-renders every avatar and model chip.
