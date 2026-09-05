# src/ui/mention

Shared mention primitive used by composer autocomplete surfaces.

## Invariants

- Inserted text comes from the item, not from the trigger. `MentionItem`'s
  `insertText` (commit) and `navigateText` (drill-down) replace the whole span
  from the trigger character to the caret, so each carries its own leading
  marker; without them the primitive falls back to `${trigger}${label}`.
- An item with `navigateText` is a navigation step: selecting it rewrites the
  trigger span, keeps the menu open, and records neither a mention range nor a
  selected value. `onMentionAdd(..., { commit: true })` overrides that and
  commits through `insertText`. Directory drill-down is one caller of this
  contract, not a primitive special case — the primitive must not infer
  navigation from a trailing `/`.
- Navigation items may use `onMentionNavigate` to synchronously start work for
  their destination. It fires for mouse and keyboard navigation, but never for
  a forced commit of the same item.
- Backspace/ArrowLeft pop a `<namespace>:` drill-down prefix back to the bare
  trigger in one keystroke (`isMentionNavigationPrefix`); path drill-downs are
  excluded so Backspace still walks a path one character at a time.
  Tab/ArrowRight descend into a highlighted navigation item. Tab also
  commits a highlighted non-navigation item the same way Enter does.
  Shift+Tab still closes the menu so the composer mode-cycle binding
  is not stolen.
- A committed mention is an atomic editing range. A collapsed caret placed
  inside it by pointer/focus/selection changes snaps to the nearest boundary;
  otherwise the chip mirror hides the native caret and the next edit silently
  decommits the range. Non-collapsed selections remain native so copy and
  whole-region edits can span mentions. At a mention boundary, the textarea is
  raised above the opaque chip and its text fill is made transparent while the
  background mirror carries the glyphs; this leaves the native caret visible
  without painting a second caret. Readonly inputs still apply this visual
  boundary constraint. IME composition is the offset exception: its transient
  caret must not snap against the still-committed ranges, and both mirrors map
  those ranges through the transient edit so the chip neither disappears nor
  exposes a duplicated suffix.
- The pop-back itself is `context.onNavigateBack()`, owned by the root next to
  `onMentionAdd`: it has to interleave the controlled value commit with caret
  restoration, so a menu's own Back affordance calls it rather than restaging the
  transaction. Callers decide only _when_ it applies.
- `mention-trigger.ts` is the single owner of the `<namespace>:` grammar
  (`parseMentionNamespaceSearch`). The menu resolves its level from the same
  parse Backspace pops from, so the two cannot disagree about what is a
  namespace.
- The menu is not the only way a range is born. `onMentionInsert` writes one
  from outside the input (a drop, a toolbar action) and takes focus; it needs no
  trigger span and no registered item. Both routes go through the single pure
  `applyMentionSplice` in `mention-input-core.ts` — they used to be separate
  copies of that arithmetic — and it in turn moves existing ranges through
  `applyTextEditToMentions`, the same rule a typed edit uses, so there is ONE
  definition of what an edit does to a range. A caller passing `separate` gets
  its whitespace resolved against the INPUT's value
  (`resolveMentionInsertPrefix`), not the caller's copy of it, which can trail
  by a keystroke. Stays product-neutral: text, payload, and kind are all
  arguments.
- `MentionKind` stays product-neutral: `pasted_text` is the only member the
  primitive branches on, and every other kind is an opaque tag the menu chooses.
  Adding a mention category must not edit this package.
- `MentionItem` registers its stable ref object, never a `{ current: node }`
  snapshot. The collection keys its map by that object and sorts by document
  position through `.current`, so a snapshot taken before the node mounts leaves
  a null-node entry behind — the sort collapses around it and highlight movement
  matches the wrong row.
- `onMentionsChange`/`onValueChange` updaters see the last value WRITTEN, not
  the last value rendered (`useFlushConsistentState` in `mention-root.tsx`).
  `useControllableState` resolves an updater against the controlled prop, and
  that prop only moves on the owner's next render — so two updates in one commit
  each saw the pre-flush value and the last one replaced the others. Every
  hydrator runs its effect in the same flush, so a draft carrying two kinds of
  mention came back from a remount holding only whichever hydrator rendered
  last. Do not "simplify" this back to a plain functional `setState`.
- The primitive does not filter. Menus rank and slice their own candidates, so
  `useFilterStore` runs with `manualFiltering`; letting the built-in scorer also
  match the search term against each item's `value` hides rows whose payload
  happens not to contain it, and a hidden row renders null, which strips its node
  from the collection and breaks arrow-key movement across groups.
- Desktop `MentionContent` is caret-anchored vertically but horizontally constrained
  to the textarea range via its virtual collision boundary and
  `--mention-input-width`.
- `MentionContent positionAnchor="input-top"` places top-side menus against the
  input wrapper's top edge instead of the current caret line.
- Menu callers should include `var(--mention-input-width)` in desktop `max-w`
  classes; viewport-only caps let wide menus escape the composer.
- Mobile mention content bypasses floating-ui and docks through
  `MentionMobilePanel`; desktop positioning classes do not control mobile layout.

## Files

- `mention-root.tsx` owns open state, active trigger, selected values, mention
  ranges, item registration, filtering, and insertion.
- `mention-input-core.ts` holds the pure text/range algebra both insertion
  routes and every edit share.
- `mention-input.tsx` owns textarea behavior: trigger detection, virtual caret
  anchor creation, controlled value sync, selection restore, and highlighter
  interaction.
- `mention-content.tsx` renders the desktop floating listbox and provides the
  input-width CSS variable; it delegates mobile rendering to `mention-mobile-content.tsx`.
- `mention-mobile-content.tsx` docks the mobile panel above the composer and
  handles drawer-safe portal placement.
- `mention-item.tsx`, `mention-label.tsx`, `mention-highlighter.tsx`, and
  `mention-trigger.ts` provide row selection, accessibility label, inline
  highlighting, and trigger/drill-down-prefix parsing helpers.
