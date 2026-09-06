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

- Dialog-contained `OptionSelector` menus must portal into the nearest
  `[data-lody-dialog-content]`; a body portal is outside Radix remove-scroll handling.
- `DiffViewer` uses the shared `@pierre/diffs` worker pools for syntax work regardless
  of file size. Do not create or terminate a worker pool per viewer.
