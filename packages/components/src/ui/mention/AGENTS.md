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
- Backspace/ArrowLeft pop a `<namespace>:` drill-down prefix back to the bare
  trigger in one keystroke (`isMentionNavigationPrefix`); path drill-downs are
  excluded so Backspace still walks a path one character at a time.
  Tab/ArrowRight descend into a highlighted navigation item.
- `MentionItem` registers its stable ref object, never a `{ current: node }`
  snapshot. The collection keys its map by that object and sorts by document
  position through `.current`, so a snapshot taken before the node mounts leaves
  a null-node entry behind — the sort collapses around it and highlight movement
  matches the wrong row.
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
