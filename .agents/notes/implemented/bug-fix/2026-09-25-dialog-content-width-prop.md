# `Dialog.Content` gains a `width` prop; `max-w-*` alone cannot widen a panel

Status: implemented
Translation: current

[中文](2026-09-25-dialog-content-width-prop.zh.md)

## Abstract

The `@lody/ui` migration changed the dialog panel from fluid width capped by
`max-w-lg` to a fixed `width: 512px` StyleX declaration. Every dialog that had
widened itself with a `max-w-{xl,2xl,3xl,4xl}` class — and no `width` — was
silently clamped back to 512px, because `max-width` can only narrow a fixed
width, never raise it. `@lody/ui`'s `ModalContentProps` — the props type shared
by `Dialog.Content` and `AlertDialog.Content` — now exposes `width`, which
lands on inline `style`, and every panel needing a non-default width uses it.
The product adapter forwards it untouched. The cmdk palette's 512px is
intentional post-rework and was left alone.

## The trap

`modal.popup` in `@lody/ui` states `width: dialog.width` (512px) plus
`maxWidth: calc(100vw - 32px)`. Three override spellings behave differently:

- `max-w-2xl` alone: `max-width` only caps, so the panel stays 512px — the
  regression this note records.
- A `w-[…]` class: works today only because `tailwind/index.css` declares
  `@layer …, stylex, …, utilities`, putting utilities after the component's
  sheet. Reliable but subtle, and overriding `max-w-*` also replaces the
  rung's `100vw - 32px` viewport cap.
- A second StyleX `width` class: unordered against the panel's own declaration
  — `settings/surface.ts` already documented this.

`width` → inline `style` sidesteps all three: inline style always wins, and it
never touches the panel's `max-width`, so the viewport cap still bounds the
panel on narrow windows. `desktop-settings-modal`'s `style` object (width plus
height/padding/gap) stays on `style`; the prop is for the one width dial.

## Changes

- `packages/ui`: `ModalContentProps` gains `width`; `mergePanelWidth` in
  `dialog/parts.tsx` composes it into the popup's `style`, whether the caller's
  style is an object or a state callback (Base UI permits both). The product
  adapter in `components/src/ui/dialog.tsx` forwards it untouched; `Drawer`
  keeps its own props type — a drawer's cross-axis size is `drawerSize`, a
  different dial. `test/dialog.test.tsx` pins the inline-style contract.
- Restored widths: composer paste preview 48rem, usage share image 56rem,
  session file quick-open 42rem, machine pairing 36rem, operation reply 42rem.
- Unified the surviving mixed spellings onto the prop:
  `chat-failed-detail` and `session-file-preview` (`w-[calc(100vw-2rem)]
  max-w-*` → `width="42rem"`/`"48rem"`), `chat-share-image` and
  `update-changelog` (`style={{width}}` → prop), `open-source-attributions`
  (`style` const → `width="1024px"`), `skill-detail` (`width`+`maxWidth` pair →
  `width="768px"`).
- `SETTINGS_EDITOR_DIALOG_LAYOUT` split: `SETTINGS_EDITOR_DIALOG_WIDTH`
  (`620px`) rides the prop; the class keeps only the height cap.
- The guardrail ("`max-w-*` alone can only narrow, never widen") is a line in
  the adapter's docblock, not `components/src/ui/AGENTS.md`: that file is
  already 8168 bytes against its 8192-byte budget, so nothing can be added to
  it.

## Evidence and limits

Cascade facts verified in source: `tailwind/index.css` layer order, the
`w-[620px]` precedent in `settings/surface.ts`, and `modal.popup`'s fixed
`width` token. Behavioral widths match pre-migration `max-w-*` values on
desktop and improve narrow-viewport behavior (the rung's cap replaces
hand-rolled `100vw - 2rem` math). Not yet run: `tsgo`/`oxlint` (nested
checkout without installed dependencies) and visual passes of each dialog.
