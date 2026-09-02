import type { CSSProperties } from 'react';
import { Loader2, Send, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Textarea } from '@/ui/textarea';

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
      className={cn(
        'pointer-events-auto w-[280px] max-w-[calc(100%-24px)] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-xl',
        className
      )}
      style={style}
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold">
            {t('sessions.preview.annotation.addComment', 'Add comment')}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{targetLabel}</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          className="shrink-0"
          aria-label={t('common.cancel', 'Cancel')}
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('sessions.preview.annotation.placeholder', 'Describe the change...')}
        className="min-h-20 resize-none bg-background text-xs"
        autoFocus={autoFocus}
      />
      <div className="mt-2 flex justify-end">
        <Button
          type="button"
          size="small"
          disabled={!value.trim() || submitting}
          onClick={onSubmit}
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          {t('sessions.preview.annotation.send', 'Send')}
        </Button>
      </div>
    </div>
  );
}
