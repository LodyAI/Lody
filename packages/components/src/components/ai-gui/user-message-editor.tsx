import { useCallback, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { Spinner } from '@lody/ui/spinner';

import { Button } from '@lody/ui/button';
import type { ConversationFontSize } from '@/atoms/settings';
import { conversationTextFontSizeStyle } from './conversation-font-size-classes';
import { CombinedMentionTextarea } from '@/components/mentions/combined-mention-textarea';
import { getComposerMentionChip } from '@/components/mentions/mention-chips';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import type { Mention as MentionRange } from '@/ui/mention/index';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import type { SkillMentionAgent } from '@/components/mentions/mention-skill-source';
import {
  reanchorMessageTextSpansForTrim,
  type AcpCommandSummary,
  type MessageTextSpan,
} from '@lody/shared';
import { useMentionPromptExpansion } from '@/components/mentions/mention-expansion';
import {
  useSessionMentionSource,
  type UseSessionMentionSourceArgs,
} from '@/hooks/use-session-mention-source';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  card: {
    display: 'flex',
    width: '32rem',
    maxWidth: '100%',
    flexDirection: 'column',
    borderRadius: themeRadius['2xl'],
    borderWidth: '0.5px',
    borderStyle: 'solid',
    borderColor: {
      default: 'hsl(var(--foreground) / 0.1)',
      ':focus-within': 'hsl(var(--foreground) / 0.25)',
    },
    backgroundColor: themeColors.background,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2.5],
    boxShadow: '0 1px 2px hsl(0 0% 0%/0.04), 0 8px 24px -16px hsl(0 0% 0%/0.12)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  input: {
    lineHeight: '1.625',
    // The card carries the focus edge; the textarea itself must not draw a
    // second outline/ring inside it (MentionInput is a bare primitive, not the
    // styled Textarea). The Tailwind ring painted nothing and erased the
    // app's own focus ring with it, so the textarea stays as blind as it was.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  inputSaving: { color: themeColors.mutedForeground },
  actions: {
    marginTop: themeSpace[2],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: themeSpace[1],
  },
});

/** Grows with the text instead of reserving a fixed empty block. */
const MAX_TEXTAREA_HEIGHT_PX = 320;

export type UserMessageEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  /** Receives trimmed, expanded text and its reanchored transcript spans. */
  onSave: (payload: {
    text: string;
    mentions: readonly MentionRange[];
    spans?: MessageTextSpan[];
  }) => void;
  isSaving: boolean;
  conversationFontSize: ConversationFontSize;
  /** Same source object the session composer resolves; wires `@` file/session/
   *  role/issue candidates into the editor. Undefined disables the tree. */
  mentionSource?: MentionProjectSource;
  /** Session data only; file resources are borrowed when this editor mounts. */
  sessionSource?: Omit<UseSessionMentionSourceArgs, 'enableCodeCollabProvider' | 'debugLabel'>;
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
 * identically to a fresh send. Mention expansion belongs to this mounted editor,
 * so a closed editor does not subscribe the conversation to mention catalogs.
 */
function UserMessageEditorContent({
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
  const { expand: expandMentions } = useMentionPromptExpansion({
    source: mentionSource,
    skillAgent,
    promptValue: value,
    currentSessionId,
  });

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
    const expanded = expandMentions({ text: value, mentions: mentionRangesRef.current });
    const text = expanded.text.trim();
    onSave({
      text,
      mentions: mentionRangesRef.current,
      spans: reanchorMessageTextSpansForTrim(expanded.text, text, expanded.spans),
    });
  }, [canSave, expandMentions, onSave, value]);

  return (
    <div
      className={clsx(
        // The dark half of the card has no StyleX equivalent, so it stays a
        // Tailwind class on this element.
        'dark:border-input-border/70',
        'dark:bg-input/90',
        'dark:focus-within:border-input-border',
        stylex.props(styles.card).className
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
        // The editor lives mid-conversation, so the menu follows the caret and
        // flips above the line when there is no room below.
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
        className={clsx(
          // The card carries the focus edge; the textarea itself must not draw
          // a second outline/ring inside it (MentionInput is a bare primitive,
          // not the styled Textarea).
          'input-scrollbar',
          stylex.props(styles.input, isSaving && styles.inputSaving).className
        )}
        style={conversationTextFontSizeStyle(conversationFontSize)}
        aria-label={t('sessions.editMessage', 'Edit message')}
      />
      <div {...stylex.props(styles.actions)}>
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

export function UserMessageEditor(props: UserMessageEditorProps) {
  return props.sessionSource ? (
    <SessionUserMessageEditor {...props} sessionSource={props.sessionSource} />
  ) : (
    <UserMessageEditorContent {...props} />
  );
}

function SessionUserMessageEditor({
  sessionSource,
  ...props
}: UserMessageEditorProps & {
  sessionSource: NonNullable<UserMessageEditorProps['sessionSource']>;
}) {
  const mentionSource = useSessionMentionSource({
    ...sessionSource,
    enableCodeCollabProvider: true,
    debugLabel: 'session-edit:mention-provider',
  });
  return <UserMessageEditorContent {...props} mentionSource={mentionSource} />;
}
