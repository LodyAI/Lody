import { useCallback, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { Button } from '@lody/ui/button';
import { Textarea } from '@/ui/textarea';
import { cn } from '@/lib/utils';
import type { ConversationFontSize } from '@/atoms/settings';
import { conversationTextFontSizeStyle } from './conversation-font-size-classes';

/** Grows with the text instead of reserving a fixed empty block. */
const MAX_TEXTAREA_HEIGHT_PX = 320;

export type UserMessageEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  isSaving: boolean;
  conversationFontSize: ConversationFontSize;
};

/**
 * In-place editor that takes the last user bubble's spot when resending.
 *
 * One surface only: the card carries the border, and the field inside is
 * transparent and chrome-free — the shared `Textarea` is what suppresses the
 * global `:focus-visible` inset ring (`@layer base` in tailwind/index.css) that
 * would otherwise draw a second rectangle around the text. Send matches the
 * composer's black pill so the two writing surfaces read as the same control.
 */
export function UserMessageEditor({
  value,
  onChange,
  onCancel,
  onSave,
  isSaving,
  conversationFontSize,
}: UserMessageEditorProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSave = value.trim().length > 0 && !isSaving;

  // Auto-size to the content: reset first so the box can also shrink when text
  // is deleted, then cap it and let the textarea scroll past the cap.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT_PX ? 'auto' : 'hidden';
  }, [value]);

  // Put the caret at the end rather than selecting everything, so the common
  // case (appending a clarification) needs no extra click.
  const focusAtEnd = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <div
      className={cn(
        'flex w-[32rem] max-w-full flex-col',
        'rounded-2xl border border-foreground/[0.10] bg-background px-3 py-2.5',
        'shadow-[0_1px_2px_hsl(0_0%_0%/0.04),0_8px_24px_-16px_hsl(0_0%_0%/0.12)]',
        'transition-colors duration-150 focus-within:border-foreground/25',
        'dark:border-input-border/70 dark:bg-input/90 dark:focus-within:border-input-border'
      )}
      aria-busy={isSaving || undefined}
    >
      <Textarea
        ref={focusAtEnd}
        value={value}
        rows={1}
        readOnly={isSaving}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!isSaving) onCancel();
            return;
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (canSave) onSave();
          }
        }}
        className={cn(
          'input-scrollbar resize-none rounded-none border-transparent bg-transparent p-0',
          'leading-relaxed text-foreground',
          isSaving && 'text-muted-foreground'
        )}
        style={conversationTextFontSizeStyle(conversationFontSize)}
        aria-label={t('sessions.editMessage', 'Edit message')}
      />
      <div className="mt-2 flex items-center justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="small"
          shape="pill"
          disabled={isSaving}
          onClick={onCancel}
        >
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="small"
          shape="pill"
          disabled={!canSave}
          onClick={onSave}
        >
          {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t('sessions.send', 'Send')}
        </Button>
      </div>
    </div>
  );
}
