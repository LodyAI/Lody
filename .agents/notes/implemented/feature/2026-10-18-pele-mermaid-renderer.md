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
about 492 kB to 251 kB gzipped. Diagrams now take their colors from the active
VS Code theme instead of two fixed slate palettes. The trade-off is a library
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
- Colors follow the theme. Pele reads `--pele-*` custom properties, and the
  markdown stylesheet maps them to theme tokens on the block: labels use the
  prose foreground, borders mix the primary color with the muted foreground,
  and edge-label backing is the block fill made opaque. Inline diagrams follow
  any theme without re-rendering, so the SVG cache and the markdown component
  map no longer depend on light/dark. The fixed palettes and the type-only
  `mermaid` dependency are gone.
- Chart series keep Pele's palette. Theme hue tokens repeat (Ayu Light's info
  and warning are one orange; Vesper's function and warning match), and a pie
  whose slices share a color is wrong in a way a themed tint does not repay.
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
  second page applied eight bundled themes through Lody's own theme-variable
  pipeline and the stylesheet's real mapping, and checked the download image,
  the viewer clone (plus an unbaked control that reverts to Pele's light
  defaults) and a snapdom capture. Low-contrast themes such as Tokyo Night stay
  as dim as their prose. Layout differs from mermaid.js, as it did with
  beautiful-mermaid. No in-app Storybook or E2E walk was run.
- Pele is new and fast-moving; upgrades need the same tarball review.
