import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../../style/theme-scale.stylex';
import type { CSSProperties } from 'react';
import { Send, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';

export type VisualAnnotationDraftComposerProps = {
  targetLabel: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitting?: boolean;
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function VisualAnnotationDraftComposer({
  targetLabel,
  value,
  onChange,
  onCancel,
  onSubmit,
  submitting = false,
  autoFocus = false,
  className,
  style,
}: VisualAnnotationDraftComposerProps) {
  const { t } = useTranslation();

  return (
    <div
      data-lody-visual-comment-draft="true"
      className={cn(stylex.props(styles.root).className, className)}
      style={style}
    >
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerText)}>
          <div {...stylex.props(styles.title)}>
            {t('sessions.preview.annotation.addComment', 'Add comment')}
          </div>
          <div {...stylex.props(styles.target)}>{targetLabel}</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          icon
          height="calc(var(--spacing) * 6)"
          width="calc(var(--spacing) * 6)"
          aria-label={t('common.cancel', 'Cancel')}
          onClick={onCancel}
        >
          <X {...stylex.props(styles.icon)} />
        </Button>
      </div>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('sessions.preview.annotation.placeholder', 'Describe the change...')}
        className="min-h-20 resize-none bg-background text-xs"
        autoFocus={autoFocus}
      />
      <div {...stylex.props(styles.footer)}>
        <Button
          type="button"
          size="small"
          disabled={!value.trim() || submitting}
          onClick={onSubmit}
        >
          {submitting ? (
            <Spinner {...stylex.props(styles.icon)} />
          ) : (
            <Send {...stylex.props(styles.icon)} />
          )}
          {t('sessions.preview.annotation.send', 'Send')}
        </Button>
      </div>
    </div>
  );
}

const styles = stylex.create({
  root: {
    pointerEvents: 'auto',
    width: '280px',
    maxWidth: 'calc(100% - 24px)',
    borderRadius: themeRadius.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: themeColors.border,
    backgroundColor: themeColors.popover,
    padding: themeSpace[3],
    color: themeColors.popoverForeground,
    boxShadow: themeShadow.xl,
  },
  header: {
    marginBottom: themeSpace[2],
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[2],
  },
  headerText: { minWidth: 0, flex: '1 1 0%' },
  title: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    fontWeight: themeFontWeight.semibold,
  },
  target: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: '10px',
    color: themeColors.mutedForeground,
  },
  icon: { width: themeSpace[3.5], height: themeSpace[3.5] },
  footer: { marginTop: themeSpace[2], display: 'flex', justifyContent: 'flex-end' },
});
