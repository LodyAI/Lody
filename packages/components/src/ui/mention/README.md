# src/ui/mention

The shared mention primitive. Rules: [AGENTS.md](AGENTS.md).

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
