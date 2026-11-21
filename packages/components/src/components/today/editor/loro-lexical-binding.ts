import { COLLABORATION_TAG, SKIP_SCROLL_INTO_VIEW_TAG, type LexicalEditor } from 'lexical';
import type { LoroText } from 'loro-crdt';
import {
  insertTodayRich,
  readTodayText,
  sameTodayRich,
  type TodayPageUndo,
  type TodayRichText,
} from '@lody/shared';
import {
  $readComposerValue,
  $readSelectionOffsets,
  $setSelectionOffsets,
  $writeComposerValue,
  type ComposerMentionRange,
} from '@/ui/mention/composer-document';
import { safeRichDiff, transformOffset, type TextDeltaStep } from './text-diff';

const INBOUND_TAGS = [COLLABORATION_TAG, SKIP_SCROLL_INTO_VIEW_TAG];

/** Placeholder chip value for a U+FFFC without a mark (a range needs a non-empty value). */
const PLACEHOLDER_VALUE = '?';

/** Node rich text as the composer's ranges: one MentionDecoratorNode per mention. */
export function todayRichToComposer(rich: TodayRichText): ComposerMentionRange[] {
  return rich.mentions.map((mention) => ({
    start: mention.start,
    end: mention.start + 1,
    value: mention.id || PLACEHOLDER_VALUE,
    kind: mention.kind,
  }));
}

/** The editor document as node rich text. */
export function $readTodayEditorRich(): TodayRichText {
  const value = $readComposerValue();
  return {
    text: value.text,
    mentions: value.mentions
      .filter((range) => range.end - range.start === 1)
      .map((range) => {
        const kind = range.kind ?? '';
        return { start: range.start, kind, id: kind ? range.value : '' };
      }),
  };
}

/**
 * Two-way binding between one node's LoroText and the active Lexical editor:
 * text plus mentions (a U+FFFC with its mark on the Loro side, a
 * MentionDecoratorNode on the editor side). Specs/today-outline.md
 * (Implementation constraints, Conversation mentions).
 *
 * Outbound: each committed editor change becomes one rich LoroText splice
 * (positions compare character and mention) through the page undo (so typing groups into undo steps). Nothing is written while an
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
  let base = readTodayText(text);
  let buffered: TextDeltaStep[][] = [];
  // The binding's own commit echoes back through `text.subscribe` at once;
  // the editor already shows it, and moving the caret through that local
  // delta would misplace it (peer edits held during a composition are
  // applied right after, through their own deltas).
  let writing = false;

  const editorRich = () => editor.getEditorState().read($readTodayEditorRich);

  const realign = (deltas: readonly (readonly TextDeltaStep[])[]) => {
    const target = readTodayText(text);
    base = target;
    buffered = [];
    if (sameTodayRich(editorRich(), target)) return;
    editor.update(
      () => {
        const selection = $readSelectionOffsets();
        $writeComposerValue(target.text, todayRichToComposer(target));
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

  editor.update(() => $writeComposerValue(base.text, todayRichToComposer(base)), {
    discrete: true,
    tag: INBOUND_TAGS,
  });

  const commit = (showPeerEdits: boolean) => {
    const next = editorRich();
    let splice = safeRichDiff(base, next);
    const pending = buffered;
    if (!splice) {
      // A composition ended without a change: show what peers wrote meanwhile.
      if (showPeerEdits && pending.length > 0) realign(pending);
      return;
    }
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
    writing = true;
    try {
      undo.editText(text, (target) => {
        if (deleteCount > 0) target.delete(start, deleteCount);
        insertTodayRich(target, start, insert);
      });
    } finally {
      writing = false;
    }
    // Peer edits were held during the composition: show them, moving the caret past them.
    if (showPeerEdits && pending.length > 0) realign(pending);
    else base = next;
  };

  const stopEditor = editor.registerUpdateListener(({ tags }) => {
    if (tags.has(COLLABORATION_TAG) || composing()) return;
    commit(true);
  });

  // A composition can end with no editor change (cancelled, or the same text):
  // no update fires then, so flush peer edits held during it explicitly.
  const onCompositionEnd = () =>
    queueMicrotask(() => {
      if (composing() || buffered.length === 0) return;
      if (safeRichDiff(base, editorRich()) === null) realign(buffered);
    });
  const stopRoot = editor.registerRootListener((root, previous) => {
    previous?.removeEventListener('compositionend', onCompositionEnd);
    root?.addEventListener('compositionend', onCompositionEnd);
  });

  const stopText = text.subscribe((batch) => {
    if (writing) return;
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
      stopRoot();
      stopText();
      // Leaving a node mid-composition: keep the preedit, as a browser does on blur.
      if (!text.isDeleted()) commit(false);
    },
  };
}
