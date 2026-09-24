# Portals restyled the whole app

Status: implemented
Translation: current

[中文](2026-09-23-portal-full-restyle.zh.md)

## Abstract

Switching sessions and hovering the sidebar felt slow on large workspaces. A Chrome trace of
the production build showed Radix `Presence` forcing a style recalculation of the entire document
(about 12,350 elements, ~30ms) every time a popover mounted. The cause was a Konsta UI utility,
`last-child-hairline-b-none`, whose unanchored `:last-child … ::after` selectors made every change
of `<body>`'s last child restyle `#root`; Konsta's sources were scanned by Tailwind although no
Konsta component is rendered. The scan is removed, a permanent sentinel keeps `#root` off
`<body>`'s tail as a second line of defence, and two smaller per-switch costs are removed. Popover
insertion dropped from ~25ms to 0.3ms in the real page; an end-to-end trace after the CSS change
has not been recorded yet.

## Evidence

- Traces were recorded over CDP from the unminified production build (`vite build --mode dev`)
  against staging, without the DevTools frontend (which crashed on this page). In the first trace,
  1.1s of 3.6s of JavaScript during session switching was `getAnimationName`; 73 forced
  `UpdateLayoutTree` events of ~15–35ms each carried that stack, each with ~12,350 elements.
- An in-page counter attributed the reads to the sidebar session hover card (`Popover`, side
  right). Mutation logging showed the card appends a popper wrapper and Radix focus guards to
  `<body>`. Appending any node to the end of `<body>` cost 23–38ms; inserting at the start cost
  nothing; inserting into a persistent sibling after `#root` cost nothing.
- Deleting CSS rules in the live page proves nothing: Blink keeps the "children affected by
  positional rules" flags once set. Instead the real DOM and all 7,302 flattened rules were cloned
  into a fresh iframe and bisected. All rules: 22–24ms; without `last-child-hairline-b-none`:
  0.2ms. A class-anchored rewrite (`> :last-child .hairline-b::after`) costs 0.3ms, while even the
  "direct child" part (`> :last-child::after`) alone costs 25.7ms. Synthetic pages with plain
  `:last-child`, `:not(:last-child)`, `~`, `:has()` or `space-y` rules did not reproduce it.
- After removing the scan, with the sentinel deliberately removed and `#root` last again, an
  append cost 0.3ms in the real page.

## Decision

- `src/tailwind/index.css` no longer `@source`-scans `konsta/react`, `konsta/shared` or
  `konsta/styles`. Only the theme, safe-area utilities and the `safe-areas` hook are used; 417
  classes (69KB) disappeared, and every flagged "still referenced" class was a false positive whose
  real variant form is still generated from our own sources.
- `lib/body-tail-sentinel.ts`, called once from `routes/__root.tsx`, inserts a hidden element right
  after `#root`, so any future positional selector from third-party CSS cannot make portal churn
  restyle the app. Web, desktop and mobile all render through that root.
- The session hover card stays shut after a press on its row until the pointer moves 4px:
  navigation re-renders rows under a still pointer, which re-fired `pointerenter` and opened a card
  in the switch commit.
- `ChatComposer` no longer measures itself with `getBoundingClientRect` in a layout effect, which
  forced style and layout of the just-committed conversation on every switch (~50ms); its
  ResizeObserver delivers the size before paint.

Rendering portals into a dedicated container was rejected as the primary fix: Radix focus guards
are always inserted on `<body>` itself, and every portal call site would need a container prop.
Overriding the Konsta utility was unnecessary once nothing references it.

## Open

Konsta's `theme.css` still imports all Konsta styles; only this utility was shown to matter. No
automated guard rejects unanchored positional selectors in the compiled CSS yet. The doc-meta
recomputation seen in the development-build Safari recording did not dominate in production and
is unchanged. Related scrolling work: [conversation follow modes](../architecture/2026-09-23-conversation-follow-modes.md).
