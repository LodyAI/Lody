# Nested modal backdrops belong to the primitive, and so do mount-open animations

Status: implemented
Translation: current

[中文版](2026-09-25-modal-nested-backdrop.zh.md)

## Abstract

After the dialog family moved to `@lody/ui` (Base UI), a dialog opened inside
another dialog painted no overlay at all: Base UI mounts no backdrop for a
nested root (`enabled: forceRender || !nested`), so the per-caller
`nestedInDialog` backdrop classes left over from the Radix era never reached an
element. Settings → Agent → New Provider therefore floated over an undimmed
settings panel. The same callers also mounted their `Dialog.Root` already open
— `machine-agent-settings.tsx` gated the whole tree on `dialogMode` — which
skips Base UI's `starting`/`ending` transition states entirely, so the enter
and exit animations never played. The shared `@lody/ui` backdrop now always
renders (`forceRender`), shares the panel's z rung so portal DOM order stacks
it between the parent panel and its own, and draws a lighter veil
(`dialog.nestedOverlay`) when `ModalDepthContext` reports an ancestor modal —
all owned by the primitive with no caller prop. `machine-agent-settings` keeps
the dialog mounted while closed and defers open by one commit, clearing
mode/machine on `onOpenChangeComplete` so both transitions play.

## Decision and evidence

This supersedes the per-caller mechanism of
[2026-09-21-nested-dialog-overlays](2026-09-21-nested-dialog-overlays.md)
while keeping its invariant: every overlay shares `--z-dialog`'s rung and
portal DOM order puts a new overlay above earlier panels and below its own
content. What changed is who owns it. The earlier fix predates the Base UI
migration — it assumed a backdrop always renders, which stopped being true.

In `packages/ui`:

- `DialogBackdrop` (used by `DialogContent` and, since `AlertDialog.Backdrop`
  is the same upstream component, by `AlertDialogContent`) and the drawer's
  backdrop pass `forceRender`, so a nested modal's veil exists at all.
- `modal.backdrop` rides `z.dialog` (80), not `z.dialogBackdrop` (70): portals
  append to the same parent, so DOM order alone interleaves panels and veils —
  no nesting counter needed, as the 09-21 note already established.
- `ModalDepthContext` (`dialog/parts.tsx`) counts ancestor modals across
  portals, which DOM ancestry cannot see; depth ≥ 1 swaps the backdrop to
  `modal.backdropNested` (`dialog.nestedOverlay`, ≈ black/20 — the page overlay
  already dims under the parent panel, so a second full veil would compound).
- Every `nestedInDialog` prop and duplicated `z-[var(--z-dialog)] bg-black/20`
  backdrop class was removed (agent config, MCP, agent roles, prompt shortcuts,
  project settings, Codex reset, add/remove local project). `backdropClassName`
  remains for genuinely bespoke backdrops such as the command palette's.

For the missing transitions in `machine-agent-settings.tsx`, the dialog stays
mounted with `open` false, opens one commit later (`useLayoutEffect`, so
`mounted && !open` in `useTransitionStatus` can yield `starting`), and clears
`dialogMode`/`dialogMachineId` only when `onOpenChangeComplete(false)` fires —
the panel's content stays intact through the exit fade. `AgentConfigDialog`
keeps its own `Dialog.Root` and its reset-on-`open` effect, so remount-per-open
semantics and its 1,500-line test surface are untouched; the only new prop is
the `onOpenChangeComplete` pass-through.

Rejected alternatives: adding `forceRender` alone (backdrop renders but still
sits at z 70 under the parent panel — invisible); hoist-only mounts at every
caller (each future nested dialog would repeat the mistake; suppression is
Base UI's default); a mount-time `@keyframes` animation (a second motion
mechanism fighting the transition model).

## Verification

`test/dialog.test.tsx` asserts a nested `Dialog.Root` produces two veils
(`[role="presentation"][data-open]` — the portal's inert internal backdrop is
excluded); `test/drawer.test.tsx` asserts backdrop and viewport share the rung.
The `NestedInSettings` story now opens the provider dialog on click, matching
the product flow, so the enter animation is exercisable. Playwright before/after
screenshots in the PR show the nested veil and a mid-flight enter transition.
A story mounts dialogs already open, so mount-open still skips `starting` —
that upstream behavior is now only a static-render quirk, not a shipped path.
