import { useCallback, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@lody/ui/spinner';

import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import type { ConversationFontSize } from '@/atoms/settings';
import { conversationTextFontSizeStyle } from './conversation-font-size-classes';
import { CombinedMentionTextarea } from '@/components/mentions/combined-mention-textarea';
import { getComposerMentionChip } from '@/components/mentions/mention-chips';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import type { Mention as MentionRange } from '@/ui/mention/index';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import type { SkillMentionAgent } from '@/components/mentions/mention-skill-source';
import type { AcpCommandSummary } from '@lody/shared';

/** Grows with the text instead of reserving a fixed empty block. */
const MAX_TEXTAREA_HEIGHT_PX = 320;

export type UserMessageEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  /** Receives the expanded text plus the committed mention ranges; the caller
   *  turns those into transcript spans the same way a send does. */
  onSave: (payload: { text: string; mentions: readonly MentionRange[] }) => void;
  isSaving: boolean;
  conversationFontSize: ConversationFontSize;
  /** Same source object the session composer resolves; wires `@` file/session/
   *  role/issue candidates into the editor. Undefined disables the tree. */
  mentionSource?: MentionProjectSource;
  /** `/` command candidates for the agent that owns this session. */
  availableCommands?: AcpCommandSummary[];
  /** Selected provider, narrowing `$` to its skill directories. */
  skillAgent?: SkillMentionAgent;
  /** Excludes the session being edited from `@session` candidates. */
  currentSessionId?: string;
};

/**
 * In-place editor that takes the last user bubble's spot when resending.
 *
 * The card owns the editor's focus edge. Inside it sits the same
 * `CombinedMentionTextarea` the composer uses, so `@`, `$` and `/` behave
 * identically to a fresh send — including the before-send expansion, which the
 * caller applies through `useMentionPromptExpansion` over the reported ranges.
 */
export function UserMessageEditor({
  value,
  onChange,
  onCancel,
  onSave,
  isSaving,
  conversationFontSize,
  mentionSource,
  availableCommands,
  skillAgent,
  currentSessionId,
}: UserMessageEditorProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Live ranges the before-send rewrite needs; they only leave the component
  // on save, alongside the text they were measured against.
  const mentionRangesRef = useRef<MentionRange[]>([]);
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

  const handleSave = useCallback(() => {
    if (!canSave) return;
    onSave({ text: value, mentions: mentionRangesRef.current });
  }, [canSave, onSave, value]);

  return (
    <div
      className={cn(
        'flex w-[32rem] max-w-full flex-col',
        'rounded-2xl border-[0.5px] border-foreground/[0.10] bg-background px-3 py-2.5',
        'shadow-[0_1px_2px_hsl(0_0%_0%/0.04),0_8px_24px_-16px_hsl(0_0%_0%/0.12)]',
        'transition-colors duration-150 focus-within:border-foreground/25',
        'dark:border-input-border/70 dark:bg-input/90 dark:focus-within:border-input-border'
      )}
      aria-busy={isSaving || undefined}
    >
      <CombinedMentionTextarea
        ref={focusAtEnd}
        // Bare textarea inside the editor card — the card is the well.
        appearance="bare"
        resize="none"
        value={value}
        onValueChange={onChange}
        rows={1}
        readOnly={isSaving}
        mentionSource={mentionSource}
        availableCommands={availableCommands}
        skillAgent={skillAgent}
        currentSessionId={currentSessionId}
        mentionSurface="session_chat"
        // The editor lives mid-conversation — the menu tracks the caret like a
        // text-completion popup (flipping above the line when there's no room
        // below), instead of docking to the card the way the bottom composer does.
        // The <640px docked strip is built for a bottom composer above the
        // keyboard; with no bottom composer it would open clipped off-screen
        // above the editor, so mobile keeps the floating popover too.
        menuAnchor="caret"
        menuMobileDocked={false}
        onMentionRangesChange={(ranges) => {
          mentionRangesRef.current = ranges;
        }}
        getMentionChip={getComposerMentionChip}
        onKeyDown={(event) => {
          if (isImeComposingKeyboardEvent(event)) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!isSaving) onCancel();
            return;
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            handleSave();
          }
        }}
        className={cn(
          // The card carries the focus edge; the textarea itself must not draw
          // a second outline/ring inside it (MentionInput is a bare primitive,
          // not the styled Textarea).
          'input-scrollbar leading-relaxed focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0',
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
          onClick={handleSave}
        >
          {isSaving ? <Spinner className="h-3.5 w-3.5" /> : null}
          {t('sessions.send', 'Send')}
        </Button>
      </div>
    </div>
  );
}
