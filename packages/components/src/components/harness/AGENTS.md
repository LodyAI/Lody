# Lody Agent harness surface

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Parent `AGENTS.md` files and the [Settings rules](../settings/AGENTS.md) also apply.

- Settings > Lody Agent renders this surface in the desktop pane: pairing,
  providers, models, plugins, permissions and the config file. The surface draws
  no chrome of its own — the pane owns the page title, close and scrolling, the
  device it is scoped to rides in that header, and the harness navigation is one
  tab row inside the pane.
- Its styling is StyleX: `harness.tokens.stylex.ts` holds the sheet's own ramp,
  `parts.ts` the atoms, and each view its `*.styles.ts`. Its controls are
  `@lody/ui`'s where the design system has one — button, input, select, switch,
  spinner, kbd — and hand-drawn where it does not. Never give it a stylesheet of
  its own.
- Its state is the local harness store (`lody-harness-v1`) until the provider and
  machine RPC wiring lands.
- Both the desktop settings pane and the narrow `/settings/lody-agent` route render
  this surface; keep it responsive rather than introducing a second settings
  implementation.
