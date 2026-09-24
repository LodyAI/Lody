# `src/ui` shared primitives

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink to this file; edit
`AGENTS.md` only. Prefer extending a primitive here over a private replacement in a
feature directory.

## Emoji picker

`ui/emoji-picker.tsx` is the shadcn `frimousse` registry component, with its two copy
strings on i18n rather than the registry's inline English.

- Its dataset SHIPS WITH THE APP. `frimousse` otherwise fetches
  `${emojibaseUrl}/${locale}/{data,messages}.json` from a public CDN, which leaves the
  picker spinning forever in an offline desktop or mobile app. Every host build must
  register `vite-emojibase-assets.ts` (see `apps/electron/electron.vite.config.ts`) and
  the picker must read `getBundledEmojibaseUrl()`.
- This is a URL contract, not an import: the library builds those paths at runtime, so
  a hashed `?url` asset cannot satisfy it and a host that forgets the plugin gets an
  empty picker. Keep the locale list in the plugin and `lib/emojibase-assets.ts` in
  step; each locale is ~750 KB.
- Anchor the URL on the Vite BASE, never on `document.baseURI` alone. The router uses
  browser history over http, so the document URL is a deep route and resolving against
  it asks for `…/settings/emojibase`, which the dev server answers with the SPA
  fallback — the picker then parses HTML as JSON.
- Keep `focus-visible:shadow-none` on its search input. The global "Pro focus style" in
  `tailwind/index.css` puts an inset `--primary` ring on any focused input through a
  zero-specificity `:where(…)` selector, so every input with its own `focus-visible:`
  utility overrides it; this bare registry input had none and was the one field in the
  app that showed it.

## Field colors

- An editable control fills with `bg-input-field`, never `bg-input`. `--input` is the
  theme's raw `input.background` and doubles as a muted chip/composer slab that may sit
  BELOW the page color in a light theme — a recessed gray field reads as disabled.
  `--input-field` (derived in `lib/vscode-theme/vscode-theme-css.ts` as the lighter of
  the field and page colors) keeps a dark theme's raised fill and lifts a light theme's
  field onto the page, where `--input-border` delimits it. Gray then means disabled
  (`disabled:bg-muted`), so keep that pair intact.

## Menus and viewers

- Dialog overlays and content share `--z-dialog`; portal DOM order puts each
  new overlay above earlier dialogs and below its own content.
- Dialog-contained `OptionSelector` menus must portal into the nearest
  `[data-lody-dialog-content]`; a body portal is outside Radix remove-scroll handling.
- `DiffViewer` uses the shared `@pierre/diffs` worker pools for syntax work regardless
  of file size. Do not create or terminate a worker pool per viewer.
- Every floating surface passes `useSafeAreaCollisionPadding` to Radix's
  `collisionPadding`; Radix defaults it to 0, which parks a colliding surface flush
  against the screen edge and caps `--radix-*-available-height` there too.
- A submenu's `sideOffset` is measured from its trigger ROW, so it must also clear the
  parent surface's `p-0.5` (2px) and the 0.5px ring each surface paints outside its border
  box. Default is `7` so the rings sit 4px apart; `3` welds the two surfaces together.
- Tooltips (`ui/tooltip.tsx`) use a `0.5px` border and
  `0 0.5px 1px 1px rgba(0,0,0,0.04)`. Do not restore a 1px border.
- Overlay list hover (menus, command palette, mention, select) is
  `bg-foreground/[0.05]` in light and `bg-white/[0.10]` in dark. Do not use
  `--hover` on popovers — it is sized for the page/sidebar and vanishes on the
  near-black dark menu fill. Kbd chips use the same 6% ink fill and muted text
  as the workspace Plus badge.
- Menu chrome lives in `menu-styles.ts`. Items are `0.9em` of `--ui-font-size`
  (the Appearance slider) / `py-1` / `min-h-7`. Settings chrome is `1em` of the
  same token. Do not go back to `text-[13px]` or `text-xs` for menu rows.
  The hairline is a `0.5px` shadow ring (not a CSS border). The ring and
  separators share the per-theme `--menu-edge-color` mix in both themes, never
  a fixed gray. Do not restore bulky
  `min-h-8` rows or a 1px ring.

## Spinner

- `animate-spin` goes on `ui/spinner.tsx` only, never on an `<svg>`. Chromium will
  not composite a transform animation on an SVG target at DPR≠1 (crbug.com/1186312),
  so an svg spinner re-runs style, pre-paint and layerize on the main thread every
  vsync: two idle sidebar spinners measured 40–50% renderer CPU on a Retina Mac.
  `Spinner` animates an HTML wrapper; put sizing, margin and colour classes on it and
  use `icon` / `spinning` for a refresh glyph that only turns while in flight. Any
  other infinite transform animation (the readiness orbit) follows the same rule.
- `Spinner`'s `spinning` defaults to TRUE, so a component that forwards its OWN
  optional `spinning`/`loading`/`spin` prop must give it a default of `false`.
  Forwarding `undefined` reaches the primitive's default and spins the icon in
  every non-loading state; that shipped as a permanently rotating "No machines
  available" and "Files unavailable" icon.
  Evidence: [spinner note](../../../../.agents/notes/implemented/bug-fix/2026-09-13-spinner-off-svg-retina-composite.md).

## Scroll area

- Keep the `@radix-ui/react-scroll-area` patch until an upstream version cancels
  thumb polling on effect cleanup. Verify both ESM and CommonJS with
  `tests/scroll-area-lifecycle.test.tsx` when upgrading; removing a thumb during
  the scroll-end debounce must not retain a frame loop or detached viewport.
- The desktop left sidebar (`loro-sidebar.tsx`) uses `type="scroll"` so the
  overlay thumb appears only while scrolling, not on pointer move. Do not
  revert it to the Radix default `hover`.

## Slider

- `ui/slider.tsx` is the native range input, not a library: the platform supplies
  keyboard stepping, Home/End, the ARIA role and value, and an OS-correct touch
  target. Two global rules in `tailwind/index.css` must be worked around, and both
  are why this is a primitive rather than an inline `<input type="range">`.
  The "Pro focus style" paints an inset `box-shadow` on any focused input through
  a zero-specificity `:where(…)`, which on a range input outlines the whole
  control, so the input carries `focus-visible:shadow-none` and the focus ring
  lives on the thumb. The global `*:focus-visible` reset forces `--tw-ring-shadow`
  to none with `!important` and custom properties inherit into pseudo-elements, so
  `ring-*` utilities are dead on the thumb too — its ring is an explicit
  `box-shadow`.
- Write every `::-webkit-slider-*` / `::-moz-range-*` class out in full. Tailwind
  scans source text for literal candidates, so a class built from a template
  literal is never generated, and a variant prefix binds only to the class right
  after it. The track fill is a `--lody-slider-fill` percentage set inline, because
  a pseudo-element cannot take a style attribute.
