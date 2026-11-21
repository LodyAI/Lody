import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MentionDecoration } from '@/ui/mention/mention-node';
import { $readMentionOffsets, $readSelectionOffsets } from '@/ui/mention/composer-document';
import { TodayMention } from '../today-session-mention';
import type { TodayEditorController } from './today-editor-controller';

type Painted = {
  decorators: Record<string, MentionDecoration>;
  /** Keys of mentions the selection covers. */
  selected: ReadonlySet<string>;
};

/**
 * Renders the active node's mentions into the editor's decorator elements
 * (as the composer's `MentionDecorations` does), with the same component the
 * static rows use. A mention the selection covers paints selected.
 */
export function TodayMentionDecorators(props: { controller: TodayEditorController }) {
  const { editor } = props.controller;
  const [painted, setPainted] = useState<Painted>({
    decorators: {},
    selected: new Set(),
  });
  useLayoutEffect(() => {
    const read = () => {
      const { offsets, selection } = editor.getEditorState().read(() => ({
        offsets: $readMentionOffsets(),
        selection: $readSelectionOffsets(),
      }));
      const selected = new Set<string>();
      if (selection && selection.start !== selection.end) {
        for (const [key, range] of Object.entries(offsets)) {
          if (selection.start < range.end && selection.end > range.start) selected.add(key);
        }
      }
      setPainted((previous) => {
        const decorators = editor.getDecorators<MentionDecoration>();
        const same =
          previous.selected.size === selected.size &&
          [...selected].every((key) => previous.selected.has(key)) &&
          Object.keys(decorators).length === Object.keys(previous.decorators).length &&
          Object.entries(decorators).every(([key, value]) => previous.decorators[key] === value);
        return same ? previous : { decorators: { ...decorators }, selected };
      });
    };
    read();
    const stopDecorators = editor.registerDecoratorListener(read);
    const stopUpdates = editor.registerUpdateListener(read);
    return () => {
      stopDecorators();
      stopUpdates();
    };
  }, [editor]);
  return (
    <>
      {Object.entries(painted.decorators).map(([key, decoration]) => {
        const element = editor.getElementByKey(key);
        if (!element) return null;
        // Caret geometry counts the whole decorator as one character.
        element.setAttribute('data-today-mention', '');
        const { kind = '', value } = decoration.range;
        return createPortal(
          <TodayMention
            mention={{ kind, id: kind ? value : '' }}
            selected={painted.selected.has(key)}
          />,
          element,
          key
        );
      })}
    </>
  );
}
