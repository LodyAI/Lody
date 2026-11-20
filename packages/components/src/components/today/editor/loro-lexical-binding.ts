import { COLLABORATION_TAG, SKIP_SCROLL_INTO_VIEW_TAG, type LexicalEditor } from 'lexical';
import type { LoroText } from 'loro-crdt';
import type { TodayPageUndo } from '@lody/shared';
import {
  $readComposerValue,
  $readSelectionOffsets,
  $setSelectionOffsets,
  $writeComposerValue,
} from '@/ui/mention/composer-document';
import { safeTextDiff, transformOffset, type TextDeltaStep } from './text-diff';

const INBOUND_TAGS = [COLLABORATION_TAG, SKIP_SCROLL_INTO_VIEW_TAG];

/**
 * Two-way plain-text binding between one node's LoroText and the active
 * Lexical editor. Specs/today-outline.md (Implementation constraints).
 *
 * Outbound: each committed editor change becomes one LoroText splice through
 * the page undo (so typing groups into undo steps). Nothing is written while an
 * IME composition is open.
 * Inbound: any LoroText change the editor does not already show (a peer, an
 * undo, a structural op on this node) realigns the editor to the text and
 * moves the caret through the event delta. During composition inbound deltas
 * are buffered and applied once the composition commits, so the IME never
 * loses its composing range.
 */
export function bindLoroText(options: {
  editor: LexicalEditor;
  text: LoroText;
  undo: TodayPageUndo;
  isComposing: () => boolean;
}): { dispose(): void } {
  const { editor, text, undo } = options;
  const composing = () => options.isComposing() || editor.isComposing();
  let base = text.toString();
  let buffered: TextDeltaStep[][] = [];

  const editorText = () => editor.getEditorState().read(() => $readComposerValue().text);

  const realign = (deltas: readonly (readonly TextDeltaStep[])[]) => {
    const target = text.toString();
    base = target;
    if (editorText() === target) return;
    editor.update(
      () => {
        const selection = $readSelectionOffsets();
        $writeComposerValue(target, []);
        if (!selection) return;
        let { start, end } = selection;
        for (const delta of deltas) {
          start = transformOffset(start, delta);
          end = transformOffset(end, delta);
        }
        $setSelectionOffsets(start, end);
      },
      { discrete: true, tag: INBOUND_TAGS }
    );
  };

  editor.update(() => $writeComposerValue(base, []), { discrete: true, tag: INBOUND_TAGS });

  const stopEditor = editor.registerUpdateListener(({ editorState, tags }) => {
    if (tags.has(COLLABORATION_TAG) || composing()) return;
    const next = editorState.read(() => $readComposerValue().text);
    let splice = safeTextDiff(base, next);
    if (!splice) return;
    const pending = buffered;
    buffered = [];
    if (pending.length > 0) {
      // A peer changed the text during the composition: rebase the local edit.
      let start = splice.start;
      let end = splice.start + splice.deleteCount;
      for (const delta of pending) {
        start = transformOffset(start, delta);
        end = transformOffset(end, delta);
      }
      splice = { ...splice, start, deleteCount: Math.max(0, end - start) };
    }
    const { start, deleteCount, insert } = splice;
    undo.editText(text, (target) => {
      if (deleteCount > 0) target.delete(start, deleteCount);
      if (insert) target.insert(start, insert);
    });
    if (pending.length > 0) realign([]);
    else base = next;
  });

  const stopText = text.subscribe((batch) => {
    const deltas: TextDeltaStep[][] = [];
    for (const event of batch.events) {
      if (event.target === text.id && event.diff.type === 'text') {
        deltas.push(event.diff.diff as TextDeltaStep[]);
      }
    }
    if (composing()) {
      buffered.push(...deltas);
      return;
    }
    realign(deltas);
  });

  return {
    dispose: () => {
      stopEditor();
      stopText();
    },
  };
}
