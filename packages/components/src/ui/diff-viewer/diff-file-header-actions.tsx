import { useState, type MouseEvent, type PointerEvent } from 'react';
import { Check, Copy, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';

import { cn } from '@/lib/utils';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeSpace } from '../../style/theme-scale.stylex';

export type DiffFileHeaderActionsProps = {
  readonly path: string;
  readonly onOpenFile?: (path: string) => void;
  readonly className?: string;
};

const styles = stylex.create({
  actions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: themeSpace[0.5] },
  button: {
    display: 'flex',
    height: themeSpace[6],
    width: themeSpace[6],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '0.25rem',
    color: {
      default: themeColors.mutedForeground,
      '@media (hover: hover)': { ':hover': themeColors.foreground },
    },
    backgroundColor: {
      default: null,
      '@media (hover: hover)': { ':hover': 'hsl(var(--accent) / 1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration, 150ms))',
    transitionTimingFunction:
      'var(--tw-ease, var(--default-transition-timing-function, cubic-bezier(0.4, 0, 0.2, 1)))',
  },
  glyph: { height: themeSpace[3.5], width: themeSpace[3.5] },
});

function stopHeaderTrigger(event: MouseEvent | PointerEvent): void {
  event.stopPropagation();
}

export function DiffFileHeaderActions({ path, onOpenFile, className }: DiffFileHeaderActionsProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = (event: MouseEvent<HTMLButtonElement>) => {
    stopHeaderTrigger(event);
    if (!path) {
      return;
    }
    void navigator.clipboard.writeText(path).then(
      () => {
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 2000);
      },
      () => undefined
    );
  };

  const handleOpen = (event: MouseEvent<HTMLButtonElement>) => {
    stopHeaderTrigger(event);
    onOpenFile?.(path);
  };

  return (
    <div className={cn(stylex.props(styles.actions).className, className)}>
      <button
        type="button"
        onPointerDown={stopHeaderTrigger}
        onClick={handleCopy}
        title={t('sessions.fileViewer.copyPath', 'Copy file path')}
        aria-label={t('sessions.fileViewer.copyPath', 'Copy file path')}
        {...stylex.props(styles.button)}
      >
        {copied ? (
          <Check {...stylex.props(styles.glyph)} aria-hidden="true" />
        ) : (
          <Copy {...stylex.props(styles.glyph)} aria-hidden="true" />
        )}
      </button>
      {onOpenFile ? (
        <button
          type="button"
          onPointerDown={stopHeaderTrigger}
          onClick={handleOpen}
          title={t('sessions.fileViewer.openFile', 'Open file')}
          aria-label={t('sessions.fileViewer.openFile', 'Open file')}
          {...stylex.props(styles.button)}
        >
          <FileText {...stylex.props(styles.glyph)} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
