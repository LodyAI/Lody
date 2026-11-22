# src/ui/mention

The shared mention primitive. Rules: [AGENTS.md](AGENTS.md).

Caret measurement uses the adjacent DOM node when a collapsed range beside an
atomic chip has no box. This keeps composer scrolling and menu anchors at the
visible insertion point, including immediately after a quote.

The document uses inline `MentionDecoratorNode`s for immutable references. Their
canonical text and UTF-16 ranges stay in Lexical; the view renders only an icon
and label, without invisible prefix/suffix characters. Selection uses the same system background and text colours as prose, without
a border, shadow or rounded corners; native text selection paint is suppressed inside it.
Dragging and Shift-click extend the range without opening a preview.

At document start, after a line break, or between mentions, an empty editable
TextNode gives the left edge a real typing target. It contains no character and
adds no width or string offset; its unmergeable flag retains it through Lexical
normalization. A node transform preserves this boundary after edits. Do not set
`user-select: none` on the atomic view: browsers can redirect left-edge typing
to the preceding line or the other side of the reference.

`Chat/MessageQuotes/QuoteSelection` and `SelectedQuote` cover the interaction and
selected appearance; browser tests also cover snapshot copying and replacement.

## Files

- `mention-root.tsx`: open state, triggers, values/ranges, registration and insertion.
- `mention-input-core.ts`: text/range algebra for insertions and edits.
- `mention-input.tsx`: the Lexical editor: mounting, owner sync, keys, IME, triggers, caret anchor.
- `composer-document.ts`, `mention-node.ts`: the string/document boundary and the chip node.
- `composer-input.ts`: the element API for text, caret and geometry.
- `mention-content.tsx`: desktop floating listbox and input-width CSS variable;
  delegates mobile docking and drawer-safe portals to `mention-mobile-content.tsx`.
- `mention-item.tsx`, `mention-label.tsx`, `mention-chip-content.tsx`, and
  `mention-trigger.ts`: selection, labels, chip painting and trigger parsing.
