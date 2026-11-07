# `src/ui` shared primitives

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink to this file; edit
`AGENTS.md` only. Prefer extending a primitive here over a private replacement in a
feature directory.

## Drawers

- Native iOS side drawers stay CSS-sized. Non-chat panels opt into
  `nativeKeyboardInset`; chat composers own their lift.
- `DrawerContent` keeps popup/modal hosts state-backed, no-drag, inside the
  modal and outside scrollers. Body portals inherit pointer lock and pass clicks through.

## Emoji picker

`ui/emoji-picker.tsx` is the shadcn `frimousse` registry component, with its two copy
strings on i18n rather than the registry's inline English.

- The popup owns floating material; the picker stays transparent. Its search
  owns one field well with a bare input; sticky headers use `popup.background`.
  Active emoji use `popup.highlight`, not an ad-hoc alpha fill.
- Its dataset SHIPS WITH THE APP. `frimousse` otherwise fetches
  `${emojibaseUrl}/${locale}/{data,messages}.json` from a public CDN, which leaves the
  picker spinning forever in an offline desktop or mobile app. Every host build must
  register `vite-emojibase-assets.ts` (see `apps/electron/electron.vite.config.ts`) and
  the picker must read `getBundledEmojibaseUrl()`.
- A URL contract, not an import — a hashed `?url` asset cannot satisfy the
  runtime-built paths; a host missing the plugin gets an empty picker. Keep the
  locale list in step with `lib/emojibase-assets.ts` (~750 KB each).
- `data.json` folds every bundled locale's `label` and `tags` into `tags`
  (build-time merge keyed on `hexcode`), because frimousse searches only the
  loaded locale — one query then matches in either product language. `label` and
  `messages.json` stay per-locale so display names and category headers keep the
  UI language.
- Anchor the URL on the Vite BASE, never `document.baseURI`: router paths are deep
  routes, so document-relative resolution asks for `…/settings/emojibase` and gets
  SPA-fallback HTML parsed as JSON.
- Keep the search input's focus shadow neutralized: its surrounding field well
  owns the focus ring. Keep forced-colors focus feedback.

## Field colors

- Rewritten fields share `field` roles: one well, or bare input in an owned well.
  Mention/Emoji follow this boundary; audit other legacy controls.
- Value, placeholder, glyph and hints use semantic roles, not text opacity or new
  alpha tokens. Active popup rows use `popup.highlight`.
- Disabled state reads `control.disabledOpacity` (45%) once at its control owner;
  never also dim its child glyph, Spinner or disabled control. Preserve native/
  ARIA behavior and still-actionable row controls.

## Menus and viewers

- Dialog overlays and content share one z rung: portal DOM order puts each new
  overlay (lighter when nested) above earlier panels and below its own.
- Dialog-contained `OptionSelector` menus must portal into the nearest
  `[data-lody-dialog-content]`; a body portal is outside the modal's scroll and
  focus guards. `src/ui/dialog.tsx` emits that attribute on every panel.
- `DiffViewer` bounds standalone inline parsing by characters AND lines; syntax
  and other parsing share Workers. Preserve context/fallbacks; no per-viewer pools.
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
- Overlay list hover (menus, command palette, select) is
  `bg-foreground/[0.05]` in light and `bg-white/[0.10]` in dark. Do not use
  `--hover` on popovers — it is sized for the page/sidebar and vanishes on the
  near-black dark menu fill. Kbd chips use the same 6% ink fill and muted text
  as the workspace Plus badge.
- Product menu extras live in `menu-styles.ts` (group label, separator, search
  shell); the surface and rows are `@lody/ui`'s popup surface. Rows track
  `0.9em` of `--ui-font-size` at weight 400, including composer pickers and
  mention menus; the edge is a `0.5px` shadow ring, never a 1px
  border.

## Spinner

- Two spinners exist and they are not interchangeable. `@lody/ui`'s `Spinner`
  (`@lody/ui/spinner`) is the loading MARK — `size`/`label`/`tone`, no glyph
  prop. `ui/spinner.tsx` is the icon ANIMATOR — `icon`/`spinning` for a refresh
  glyph that only turns while in flight. Use the mark for "work is under way";
  use the animator for an existing icon that must spin.
- Infinite transform animations go on an HTML wrapper, never SVG: Chromium cannot
  composite SVG transforms at DPR≠1 (crbug.com/1186312). Spinner and readiness
  orbit follow this rule. `className` lands on the wrapper; margins space the box.
- `Spinner`'s `spinning` defaults to TRUE: a component forwarding its own optional
  `spinning`/`loading`/`spin` prop must default it to `false` — `undefined` hits the
  primitive's default and spins at rest ("No machines available" shipped that way).
  Evidence: [spinner note](../../../../.agents/notes/implemented/bug-fix/2026-09-13-spinner-off-svg-retina-composite.md).

## Scroll area

- Use `@lody/ui/scroll-area` (Base UI). Its `viewportRef` is the scrolling node;
  never query vendor attributes from the root. Native controls share its tokens
  through `nativeScrollbar`; `../tailwind/scrollbars.css` covers product containers.
  Hidden bars, compact tracks and conversation gutters stay local.
- Sidebar keeps `visibility="scroll"` (visible while scrolling), never `hover`.

## Slider

- `ui/slider.tsx` is the native range input, not a library: the platform supplies
  keyboard stepping, Home/End, the ARIA role and value, and an OS-correct touch
  target. Two global rules in `tailwind/index.css` must be worked around, and both
  are why this is a primitive rather than an inline `<input type="range">`.
  The "Pro focus style" paints an inset `box-shadow` on any focused input through
  a zero-specificity `:where(…)`, which on a range input outlines the whole
  control, so the input neutralizes its `:focus-visible` shadow and the focus ring
  lives on the thumb. The global `*:focus-visible` reset forces `--tw-ring-shadow`
  to none with `!important` and custom properties inherit into pseudo-elements, so
  `ring-*` utilities are dead on the thumb too — its ring is an explicit
  `box-shadow`.
- Declare `::-webkit-slider-*` and `::-moz-range-*` as separate static StyleX
  selectors, including their hover and focus states. Verify both browser engines;
  Chromium cannot validate the Mozilla selectors. The track fill is a
  `--lody-slider-fill` percentage set inline, because a pseudo-element cannot
  take a style attribute.

## Legacy Sidebar

- Preserve Slot, refs, events and actual in-repository caller behavior. Compose
  caller styles through typed `xstyle`; migrate callers with the owner. Do not
  retain Tailwind for arbitrary hypothetical utility collisions. See
  [migration](../style/MIGRATION.md).
