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
- `data.json` folds every bundled locale's `label` and `tags` into `tags`
  (build-time merge keyed on `hexcode`), because frimousse searches only the
  loaded locale — one query then matches in either product language. `label` and
  `messages.json` stay per-locale so display names and category headers keep the
  UI language.
- Anchor the URL on the Vite BASE, never on `document.baseURI` alone. The router uses
  browser history over http, so the document URL is a deep route and resolving against
  it asks for `…/settings/emojibase`, which the dev server answers with the SPA
  fallback — the picker then parses HTML as JSON.
- Keep `focus-visible:shadow-none` on its search input: `tailwind/index.css`'s
  zero-specificity "Pro focus style" rings every focused input unless a
  `focus-visible:` utility overrides it, and this bare registry input had none.

## Field colors

- An editable control fills with `bg-input-field`, never `bg-input`. `--input` is the
  theme's raw `input.background` and doubles as a muted chip/composer slab that may sit
  BELOW the page color in a light theme — a recessed gray field reads as disabled.
  `--input-field` (derived in `lib/vscode-theme/vscode-theme-css.ts` as the lighter of
  the field and page colors) keeps a dark theme's raised fill and lifts a light theme's
  field onto the page, where `--input-border` delimits it. Gray then means disabled
  (`disabled:bg-muted`), so keep that pair intact.

## Menus and viewers

- Dialog overlays and content share one z rung: portal DOM order puts each new
  overlay above earlier dialogs and below its own content.
- Dialog-contained `OptionSelector` menus must portal into the nearest
  `[data-lody-dialog-content]`; a body portal is outside the modal's scroll and
  focus guards. `src/ui/dialog.tsx` emits that attribute on every panel.
- `DiffViewer` uses the shared `@pierre/diffs` worker pools for syntax work regardless
  of file size. Do not create or terminate a worker pool per viewer.
- Every floating surface passes `useSafeAreaCollisionPadding` as
  `collisionPadding`; the default parks a colliding surface flush against the
  screen edge and caps `--available-height` there too.
- Menus, context menus, dialogs, alert dialogs, popovers and tooltips come from
  `@lody/ui` through the adapters in `src/ui/{menu,dialog,card}.tsx` or direct
  package imports. Base UI opens on `mousedown` (scheduled in a frame), exposes
  `data-open` rather than `data-state`, and maps `asChild` to `render`, `onSelect`
  to `onClick`, and `onOpenAutoFocus`/`onCloseAutoFocus` to `initialFocus`/`finalFocus`.
  `ui/menu.tsx` also owns the composer-focus policy, the menu search input and a
  standalone `Menu.Label`; `ui/dialog.tsx` owns `data-lody-dialog-content` and
  the WindowDragStrip backdrop. An `AlertDialog` answer that must stay open
  while work is in flight is a plain `Button`, never `Action`/`Cancel` —
  those are `Close`, and `Close` always closes.
- Tooltips come from `@lody/ui/tooltip` (Base UI): `Tooltip.Provider/Root/
  Trigger/Content`, `render` instead of `asChild`, `delay` on the trigger or
  provider. The chip is visual-only — no `role="tooltip"`, no
  `aria-describedby` — so an icon-only trigger names itself with `aria-label`.
- Overlay list hover (menus, command palette, mention, select) is
  `bg-foreground/[0.05]` in light and `bg-white/[0.10]` in dark. Do not use
  `--hover` on popovers — it is sized for the page/sidebar and vanishes on the
  near-black dark menu fill. Kbd chips use the same 6% ink fill and muted text
  as the workspace Plus badge.
- Product menu extras live in `menu-styles.ts` (group label, separator, search
  shell); the surface and rows are `@lody/ui`'s popup surface. Rows track
  `0.9em` of `--ui-font-size`; the edge is a `0.5px` shadow ring, never a 1px
  border.

## Spinner

- Two spinners exist and they are not interchangeable. `@lody/ui`'s `Spinner`
  (`@lody/ui/spinner`) is the loading MARK — `size`/`label`/`tone`, no glyph
  prop. `ui/spinner.tsx` is the icon ANIMATOR — `icon`/`spinning` for a refresh
  glyph that only turns while in flight. Use the mark for "work is under way";
  use the animator for an existing icon that must spin.
- `animate-spin` goes on an HTML wrapper only, never on an `<svg>`. Chromium will
  not composite a transform animation on an SVG target at DPR≠1 (crbug.com/1186312),
  so an svg spinner re-runs style, pre-paint and layerize on the main thread every
  vsync: two idle sidebar spinners measured 40–50% renderer CPU on a Retina Mac.
  Both implementations obey this; any other infinite transform animation (the
  readiness orbit) follows the same rule.
- `Spinner`'s `spinning` defaults to TRUE: a component forwarding its own optional
  `spinning`/`loading`/`spin` prop must default it to `false` — `undefined` hits the
  primitive's default and spins at rest ("No machines available" shipped that way).
  Evidence: [spinner note](../../../../.agents/notes/implemented/bug-fix/2026-09-13-spinner-off-svg-retina-composite.md).

## Working grid

- Session working/unread marks go through `working-status-mark.tsx`, mounted across the
  change; animate only `transform`/`opacity`, loops pinned to `startTime = 0` (the shared
  sea), never rAF, timers or React state.
  [Note](../../../../.agents/notes/implemented/feature/2026-09-24-sidebar-working-grid.md).

## Scroll area

- Keep the `@radix-ui/react-scroll-area` patch until an upstream version cancels
  thumb polling on effect cleanup. Verify both ESM and CommonJS with
  `tests/scroll-area-lifecycle.test.tsx` when upgrading; removing a thumb during
  the scroll-end debounce must not retain a frame loop or detached viewport.
- `loro-sidebar.tsx` uses `type="scroll"` so the overlay thumb appears only while
  scrolling; do not revert to the Radix default `hover`.

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
