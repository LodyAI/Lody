# Render chat Mermaid diagrams with Pele

Status: implemented
Translation: current

[中文](2026-10-18-pele-mermaid-renderer.zh.md)

## Abstract

Chat Mermaid fences rendered through beautiful-mermaid, which supports only
flowchart, state, sequence, class, ER and XY charts. Agents' Gantt, pie, mindmap,
timeline and git graphs therefore showed as source text. Pele, Obsidian's MIT
renderer, covers every built-in Mermaid 12.1 type with no dependencies and
replaces it behind the same lazy boundary; the guarded diagram chunk falls from
about 492 kB to 251 kB gzipped. Diagrams now take their colors from the app's
own palette tokens instead of a separate slate palette that clashed with
Vesper's graphite chrome. The trade-off is a library
first released on 2026-10-06, adopted as an exact, reviewed version ahead of the
seven-day quarantine.

## Decision

- Only the renderer changes. `markdown-mermaid.ts` lazily imports `pele`, calls
  `render()`, and keeps the existing source-listing fallback for rejected input
  (syntax errors, ZenUML, size limits) and runtime load failures. Activation,
  gestures, the viewer and download controls are untouched.
- `mount()` and `enableZoom()` are not used: they observe container width and add
  their own zoom, which would conflict with the
  [inline view contract](../../../../specs/mermaid-inline-view.md).
- `links: false` and `images: false`: Pele otherwise emits `click` URLs and
  remote node images (verified with a synthetic diagram), and the local desktop
  must not fetch or navigate from agent output.
- Colors come from the app palette. Lody ships two palettes, Lody Light and
  deep-sea Vesper, and the old hand-picked slate colors matched neither (a navy
  `#0b1120` canvas inside Vesper's graphite). Pele reads `--pele-*` custom
  properties, and the markdown stylesheet maps them to the palette tokens on
  the block: labels use the prose foreground, borders mix the primary color with
  the muted foreground, and edge-label backing is the block fill made opaque.
  Palette changes now reach diagrams with no second table to keep in sync, and
  switching light/dark needs no re-render, so the SVG cache and the markdown
  component map no longer depend on it. The fixed palettes and the type-only
  `mermaid` dependency are gone.
- Chart series keep Pele's categorical palette. The only hue tokens are status
  colors, which carry meaning (a "danger" slice misreads) and are not built to
  be told apart side by side.
- Copies that leave the block resolve the colors where the diagram sits and
  declare them on their root: SVG/PNG download and the portalled full-screen
  clone. A one-pixel canvas paint normalizes `hsl()`/`color-mix()` to plain
  `rgb()` so other SVG consumers can read the file. The share image (snapdom)
  computes styles itself and needs nothing extra.
- `pele@1.6.0` is listed in `minimumReleaseAgeExclude`. Its tarball has no
  dependencies or install scripts, and its bundle contains no `fetch`, `eval`
  or `new Function`. Later versions remain quarantined.
- The Vite resolver that pointed `@meowdown/react`'s private beautiful-mermaid
  chunk at Lody's copy is removed. Nothing imports meowdown since the Tasks
  product was removed, so beautiful-mermaid stays only as its unused transitive
  dependency.

## Alternatives

- Keep beautiful-mermaid: smaller API surface, but the unsupported types stay as
  source text.
- Return to mermaid.js: full coverage, but it is the 1.6 MB runtime #46 removed,
  and it renders through the DOM.

## Evidence and limits

- `tests/markdown-mermaid-plugin.test.ts` now runs real Pele: flowchart, pie and
  Gantt rendering with no baked palette, link/image removal, fallbacks, and the
  color baking used by downloads and the viewer clone.
- `electron-vite build --mode oss` passes the Mermaid lazy-boundary guard;
  `mermaid-deps` is 677 kB minified / 251 kB gzipped, against 1.63 MB / 492 kB
  for beautiful-mermaid with elkjs bundled the same way.
- A Chromium page rendered twelve diagram types through the real module. A
  second page applied Lody Light and Vesper through Lody's own theme-variable
  pipeline and the stylesheet's real mapping, and checked the download image,
  the viewer clone (plus an unbaked control that reverts to Pele's light
  defaults) and a snapdom capture. Layout differs from mermaid.js, as it did
  with beautiful-mermaid. No in-app Storybook or E2E walk was run.
- Pele is new and fast-moving; upgrades need the same tarball review.
