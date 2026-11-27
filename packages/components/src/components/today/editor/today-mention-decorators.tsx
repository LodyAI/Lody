import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MentionDecoration } from '@/ui/mention/mention-node';
import {
  $readComposerValue,
  $readMentionOffsets,
  $readSelectionOffsets,
} from '@/ui/mention/composer-document';
import { TodayMention, todayMentionGaps, type TodayMentionGaps } from '../today-session-mention';
import type { TodayEditorController } from './today-editor-controller';

type Painted = {
  decorators: Record<string, MentionDecoration>;
  /** Keys of mentions the selection covers. */
  selected: ReadonlySet<string>;
  /** Each mention's own gaps (`todayMentionGaps`), by node key. */
  gaps: Readonly<Record<string, TodayMentionGaps>>;
};

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((key) => b.has(key));

const sameGaps = (
  a: Readonly<Record<string, TodayMentionGaps>>,
  b: Readonly<Record<string, TodayMentionGaps>>
) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(
    ([key, gaps]) => b[key]?.before === gaps.before && b[key]?.after === gaps.after
  );

const NO_GAPS: TodayMentionGaps = { before: false, after: false };

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
    gaps: {},
  });
  useLayoutEffect(() => {
    const read = () => {
      const { offsets, selection, text } = editor.getEditorState().read(() => ({
        offsets: $readMentionOffsets(),
        selection: $readSelectionOffsets(),
        text: $readComposerValue().text,
      }));
      const selected = new Set<string>();
      if (selection && selection.start !== selection.end) {
        for (const [key, range] of Object.entries(offsets)) {
          if (selection.start < range.end && selection.end > range.start) selected.add(key);
        }
      }
      // The same rule and node text as the static row, so mounting the editor moves nothing.
      const gaps: Record<string, TodayMentionGaps> = {};
      for (const [key, range] of Object.entries(offsets)) {
        gaps[key] = todayMentionGaps(text, range.start);
      }
      setPainted((previous) => {
        const decorators = editor.getDecorators<MentionDecoration>();
        const same =
          sameKeys(previous.selected, selected) &&
          sameGaps(previous.gaps, gaps) &&
          Object.keys(decorators).length === Object.keys(previous.decorators).length &&
          Object.entries(decorators).every(([key, value]) => previous.decorators[key] === value);
        return same ? previous : { decorators: { ...decorators }, selected, gaps };
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
            gaps={painted.gaps[key] ?? NO_GAPS}
          />,
          element,
          key
        );
      })}
    </>
  );
}
