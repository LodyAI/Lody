# UI migration merge residue

Status: implemented
Translation: current

[中文](2026-09-21-ui-merge-residue.zh.md)

## Abstract

The UI migration branch retained conflict markers in eight component files and newer callers of
primitives that the branch had deleted. This repair resolves the conflicts against the current
product code, migrates every remaining caller to the existing `@lody/ui` contracts, and removes
the orphaned Select and Toggle modules. It preserves product workflows and the established token
choices. Updating the five stale ACP submodule pins restores the repository-wide type check and
aligns the managed Codex runtime used by the build.

## Resolution

Follow the [Button migration decision](../architecture/2026-09-08-ui-button-migration-takeover.md):
retain current product behavior and use the new primitive contract without an adapter for the old
API. Keep the project-removal hooks and dialog, EmojiField and FormMessage, the shared image
exporter, the native slider, and the mobile Spinner. Discard stale imports for the old emoji
picker, image exporter, and Tasks flag.

The shared UI barrel re-exports the existing v2 primitives instead of referencing deleted local
files. Remaining Button, field, feedback, avatar, disclosure, Select, checkbox, and drawer callers
use their v2 contracts directly. Select roots state their items and reject an impossible `null`
selection instead of casting it. The orphaned Radix Select and Toggle implementations are deleted
after their callers reach zero.

The CLI already consumed ACP capabilities present on current `main`, but this branch still pinned
older ACP adapter revisions. In particular, `acp-extension-codex` depended on Codex 0.153.4 while
the lockfile and managed-runtime manifest required 0.154.0, and `acp-extension-claude` depended on
the 0.3.258 SDK while its runtime manifest required 0.3.274. The Claude, Codex, core, DSH, and Grok
gitlinks now match `origin/main`, restoring the declarations required by the CLI and the
single-version runtime contracts without changing the CLI itself.

The existing package manifests already declared the v2 UI workspace dependency and StyleX build
plugins, but the lockfile predated those declarations. Regenerating it restores frozen installs.
The components Vitest configuration now runs the same StyleX transform as the application build,
so tests importing v2 primitives execute without a temporary configuration. The Storybook preview
pipeline applies the same `@stylexjs/unplugin` transform with the package's `stylex-options.ts`;
without it the preview entry evaluates `@lody/ui` `.stylex.ts` sources raw, `stylex.defineVars`
throws during module evaluation, and every story renders a blank root with no surfaced error.

A pointer-opened Base UI Select kept DOM focus on its trigger while highlighting the selected row.
Its trigger navigation consequently treated every arrow press as the first entry into the list,
and Home/End did not reach list navigation. The v2 trigger now hands focus to the highlighted row
before arrow navigation and directly focuses the first or last enabled row for Home/End.

Node 26 exposes an unavailable storage getter when no storage file is configured, and jsdom does
not provide `PointerEvent`. Deterministic test setup now supplies those browser boundaries where
needed. Storage-failure tests spy on the active storage object rather than assuming its prototype.
The stale Tasks beta-gate suite is removed with the product flag it tested, and the share checkbox
assertion follows the v2 control's `aria-checked="mixed"` contract. The large-file pagination labels
are present in both locale catalogs.

## Verification

- No conflict markers or imports of the deleted UI modules remain in component sources.
- `pnpm --filter @lody/ui typecheck` passes.
- `pnpm --filter @lody/components typecheck` passes with no remaining errors.
- `pnpm typecheck` passes across the root workspace after the ACP gitlink updates.
- `pnpm build` completes the CLI and Electron production builds.
- The `@lody/ui` suite passes all 274 tests, including Select pointer-to-keyboard navigation.
- The existing message-selection suite passes all four behavioral tests with the checked-in
  components Vitest configuration.
- The components suite passes all 3,775 tests across 479 files; the code-review-helper suite passes
  all 34 tests; and the Electron suite passes all 150 tests.
- Translation, Code Collab import, platform-boundary, and public-boundary guards pass.

No package manifest change is required: the Radix failures came from orphaned source modules, the
missing dependency graph came from the stale lockfile, and the ACP mismatch came from stale
gitlinks. The existing
[UI primitive Spec](../../../../specs/ui-primitives.md) is unchanged because this repair restores
its intended imports and contracts rather than changing the design intent.
