import { useState, type MouseEvent, type PointerEvent } from 'react';
import { Check, Copy, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';

export type DiffFileHeaderActionsProps = {
  readonly path: string;
  readonly onOpenFile?: (path: string) => void;
  readonly className?: string;
};

const HEADER_ICON_BUTTON_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

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
    void copyTextToClipboard(path).then(
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
    <div className={cn('flex shrink-0 items-center gap-0.5', className)}>
      <button
        type="button"
        onPointerDown={stopHeaderTrigger}
        onClick={handleCopy}
        title={t('sessions.fileViewer.copyPath', 'Copy file path')}
        aria-label={t('sessions.fileViewer.copyPath', 'Copy file path')}
        className={HEADER_ICON_BUTTON_CLASS}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
      {onOpenFile ? (
        <button
          type="button"
          onPointerDown={stopHeaderTrigger}
          onClick={handleOpen}
          title={t('sessions.fileViewer.openFile', 'Open file')}
          aria-label={t('sessions.fileViewer.openFile', 'Open file')}
          className={HEADER_ICON_BUTTON_CLASS}
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
