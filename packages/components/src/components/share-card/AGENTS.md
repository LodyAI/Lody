# Share cards (`components/share-card`)

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink; edit this file only.
Intent: [chat image export](../../../../../specs/chat-share-image.md). Rationale:
[the redesign note](../../../../../.agents/notes/implemented/feature/2026-09-14-chat-share-card-fixed-template.md).

- `chat-share-card.tsx` is ONE fixed template, not an appearance editor: one gutter
  per band, left-aligned turns, unconditional code wrap, no height cap, no QR.
  Size, `mat`, backdrop and palette are the ONLY choices; none changes the layout.
- Size (`chat`/`post`) sets the measure and is asked as where the image goes, never
  as a number; the device only seeds it, and decides nothing else about the image.
- `mat` is the one continuous dimension — a slider, because a live preview answers
  "how much" better than any name — seeded from size. Under `MIN_SIGN_OFF_MAT`, or
  with no backdrop, the sign-off moves into the caption and the drop shadow goes:
  a shadow needs a ground to fall on.
- Every interior dimension lives in `LAYOUT`, never in the markup. The scoped
  `CODE_CSS` carries no `!important`: the app's code styles sit in
  `@layer components`, where a layered important declaration outranks an unlayered
  one, so the wrap and the label clearance both land on the `pre`.
- `../sessions/chat-share-image-dialog.tsx` previews those four controls and two
  actions, shape row then surface row; drawer on a handset, dialog otherwise. It
  completes only on a real copy or save — `exportShareImage` reports `{ saved }`
  so a cancelled file picker closes nothing and clears no selection.
