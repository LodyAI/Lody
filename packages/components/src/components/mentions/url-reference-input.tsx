import * as React from 'react';
import { MentionInput, useMentionContext } from '@/ui/mention';
import type { Mention, MentionInputProps } from '@/ui/mention/index';
import { getTextDiff } from '@/ui/mention/mention-input-core';
import { findPastedUrlReferences } from './url-reference-source';

export const UrlReferenceInput = React.forwardRef<HTMLTextAreaElement, MentionInputProps>(
  function UrlReferenceInput({ onInput, ...props }, ref) {
    const context = useMentionContext('UrlReferenceInput');
    const { inputValue, onMentionsChange } = context;
    const pending = React.useRef<{ text: string; ranges: Mention[] } | null>(null);
    React.useLayoutEffect(() => {
      const insertion = pending.current;
      if (!insertion) return;
      pending.current = null;
      if (inputValue !== insertion.text) return;
      onMentionsChange((current) =>
        [
          ...current,
          ...insertion.ranges.filter(
            (range) =>
              !current.some((existing) => range.start < existing.end && range.end > existing.start)
          ),
        ].sort((a, b) => a.start - b.start)
      );
    }, [inputValue, onMentionsChange]);
    return (
      <MentionInput
        {...props}
        ref={ref}
        onInput={(event) => {
          onInput?.(event);
          const native = event.nativeEvent;
          if (
            !(native instanceof InputEvent) ||
            native.isComposing ||
            (native.inputType !== 'insertFromPaste' && native.inputType !== 'historyRedo')
          )
            return;
          const next = event.currentTarget.value;
          const diff = getTextDiff(context.inputValue, next);
          if (!diff) return;
          const ranges = findPastedUrlReferences(next.slice(diff.start, diff.nextEnd), diff.start);
          if (ranges.length) pending.current = { text: next, ranges };
        }}
      />
    );
  }
);
