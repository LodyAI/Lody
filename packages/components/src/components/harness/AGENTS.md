# Lody Agent harness surface

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Parent `AGENTS.md` files and the [Settings rules](../settings/AGENTS.md) also apply.

- Settings > Lody Agent renders this surface directly in the desktop pane without a standalone first-run setup wizard: pairing, model sources, default model, plugins, permissions, and devices. The surface draws no chrome of its own — the pane owns the page title, close, and scrolling, the device it is scoped to rides in that header, and the harness navigation is one tab row inside the pane.
- Model sources reuse `@/components/onboarding/shared/connect-model-sheet` (`ConnectModelSheet`) both inline when no providers are connected on the local machine and when adding another connection, displaying non-secret provenance badges (`Subscription`, `Imported from ...`, `API Key ····last4`) alongside custom endpoint management.
- Its styling is StyleX: `harness.tokens.stylex.ts` holds the sheet's own ramp, `parts.ts` the atoms, and each view its `*.styles.ts`. Never give it a stylesheet of its own.
- The device switcher in the pane header is the surface's only machine selection (`harness.select`, keyed by `MachineId`). The Sorbet bridge, the Model sources rows, and the scoped pages all read that selection; never add a second machine picker.
- Providers, custom endpoints, and the model catalog are Sorbet's on the selected machine, read and written over Machine RPC. Model, effort, and autonomy (defaulting to `ask`) are the Sorbet Provider's `sessionDefaults`; the local harness store (`lody-harness-v1`) keeps only the selection and which profile values were set. Every visible control must either change what a conversation runs with or be disabled and labelled as unsupported; never add one that only writes local state. See [session defaults](../settings/README.md#session-defaults).
- Both the desktop settings pane and the narrow `/settings/lody-agent` route render this surface; keep it responsive and keep `harness/index.tsx` out of the eager initial renderer bundle.
