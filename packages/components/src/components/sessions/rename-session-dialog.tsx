import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { dialog } from '@lody/ui/dialog/dialog.tokens.stylex';
import { field as fieldTokens } from '@lody/ui/field/field.tokens.stylex';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import type { SessionId } from '@lody/shared';
import { Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { useSessionActions } from '@/hooks/use-session-actions';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  titleFieldLayout: {
    [fieldTokens.textareaMinHeight]: 'calc(var(--spacing) * 9)',
    [fieldTokens.paddingBlock]: 'calc(var(--spacing) * 2)',
  },
  titleTypography: {
    [dialog.titleSize]: 'var(--text-base)',
    [dialog.titleLeading]: 'var(--tw-leading, var(--text-base--line-height))',
  },
  content: { overflow: 'hidden' },
  header: {
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 70%, transparent)',
    paddingLeft: { default: themeSpace[4], '@media (min-width: 40rem)': themeSpace[5] },
    paddingRight: themeSpace[12],
    paddingBlock: themeSpace[4],
    textAlign: 'left',
  },
  body: {
    paddingInline: { default: themeSpace[4], '@media (min-width: 640px)': themeSpace[5] },
    paddingBlock: themeSpace[4],
  },
  footer: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 70%, transparent)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted) / 1) 30%, transparent)',
    paddingInline: { default: themeSpace[4], '@media (min-width: 40rem)': themeSpace[5] },
    paddingBlock: themeSpace[3],
  },
});

const MAX_VISIBLE_TITLE_LINES = 4;

const normalizePlainTextTitle = (value: string) => {
  return value.replace(/[\r\n]+/g, ' ').trim();
};

const resizeTitleTextarea = (textarea: HTMLTextAreaElement) => {
  const computed = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
  const borderTop = Number.parseFloat(computed.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(computed.borderBottomWidth) || 0;
  const chromeHeight = paddingTop + paddingBottom + borderTop + borderBottom;
  const minHeight = lineHeight + chromeHeight;
  const maxHeight = lineHeight * MAX_VISIBLE_TITLE_LINES + chromeHeight;

  textarea.style.height = `${minHeight}px`;
  const scrollHeight = textarea.scrollHeight + borderTop + borderBottom;
  const nextHeight = textarea.value
    ? Math.max(minHeight, Math.min(scrollHeight, maxHeight))
    : minHeight;

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.value && scrollHeight > maxHeight ? 'auto' : 'hidden';
};

export type RenameSessionDialogTarget = {
  sessionId: SessionId;
  initialTitle: string;
};

export type RenameSessionDialogProps = {
  target: RenameSessionDialogTarget | null;
  onClose: () => void;
};

export type RenameSessionDialogViewProps = RenameSessionDialogProps & {
  onRename: (sessionId: SessionId, nextTitle: string) => void | Promise<void>;
};

export function RenameSessionDialogView({
  target,
  onClose,
  onRename,
}: RenameSessionDialogViewProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // The field is held as state rather than in a ref so that measuring and
  // observing follow the element itself: the dialog content can remount under
  // us, and an effect keyed on anything else would keep working on the node it
  // first saw.
  const [titleField, setTitleField] = useState<HTMLTextAreaElement | null>(null);
  const measuredWidthRef = useRef<number | null>(null);

  const resizeTitle = useCallback((field: HTMLTextAreaElement | null) => {
    if (!field) return;
    resizeTitleTextarea(field);
    measuredWidthRef.current = field.clientWidth;
  }, []);

  useEffect(() => {
    if (target) {
      setDraft(target.initialTitle);
      setSaving(false);
    }
  }, [target]);

  useLayoutEffect(() => {
    resizeTitle(titleField);
  }, [draft, titleField, resizeTitle]);

  // How many lines a title wraps to is only knowable once the field has its
  // real width, and the measurement above can run before the portalled dialog
  // panel has been laid out. Without this the field keeps the one-line height
  // that first measurement produced and clips a wrapped title. Width is the
  // only input that changes here — the heights written back never alter it —
  // so re-measuring on an unchanged width would be pure churn.
  useEffect(() => {
    if (!titleField) return undefined;
    return observeResizeOnAnimationFrame(titleField, () => {
      if (titleField.clientWidth === measuredWidthRef.current) return;
      resizeTitle(titleField);
    });
  }, [titleField, resizeTitle]);

  const handleOpenChange = (open: boolean) => {
    if (!open && !saving) {
      onClose();
    }
  };

  const handleSubmit = async () => {
    if (!target) return;
    const nextTitle = normalizePlainTextTitle(draft);
    if (!nextTitle || nextTitle === target.initialTitle.trim()) {
      onClose();
      return;
    }
    try {
      setSaving(true);
      await onRename(target.sessionId, nextTitle);
      onClose();
    } catch (error: unknown) {
      toast.error(String(error instanceof Error ? error.message : error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={target != null} onOpenChange={handleOpenChange}>
      <Dialog.Content
        padding="none"
        gap="none"
        className={clsx(stylex.props(styles.content).className, 'max-w-sm')}
      >
        <Dialog.Header className={stylex.props(styles.header).className}>
          <Dialog.Title className={stylex.props(styles.titleTypography).className}>
            {t('sidebar.renameChat.title', 'Rename Chat')}
          </Dialog.Title>
          <Dialog.Description className="leading-5">
            {t('sidebar.renameChat.description', 'Enter a new name for this chat.')}
          </Dialog.Description>
        </Dialog.Header>

        <div {...stylex.props(styles.body)}>
          <Textarea
            ref={setTitleField}
            autoFocus
            rows={1}
            value={draft}
            disabled={saving}
            resize="none"
            style={{ overflowY: 'hidden' }}
            className={clsx(
              stylex.props(styles.titleFieldLayout).className,
              'leading-5 shadow-xs focus-visible:ring-1 focus-visible:ring-ring'
            )}
            onChange={(e) => setDraft(e.target.value.replace(/[\r\n]+/g, ' '))}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isImeComposingKeyboardEvent(e)) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
        </div>

        <Dialog.Footer className={stylex.props(styles.footer).className}>
          <Button variant="secondary" size="small" onClick={onClose} disabled={saving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="small"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={saving || normalizePlainTextTitle(draft).length === 0}
          >
            {t('common.save', 'Save')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function RenameSessionDialog({ target, onClose }: RenameSessionDialogProps) {
  const { updateSessionTitle } = useSessionActions();

  return (
    <RenameSessionDialogView target={target} onClose={onClose} onRename={updateSessionTitle} />
  );
}
