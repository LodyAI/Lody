import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SessionId } from '@lody/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { useSessionActions } from '@/hooks/use-session-actions';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';

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
    <Dialog open={target != null} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm gap-0 overflow-hidden p-0 sm:p-0">
        <DialogHeader className="border-b border-border/70 px-4 py-4 pr-12 text-left sm:px-5 sm:pr-12">
          <DialogTitle className="text-base">
            {t('sidebar.renameChat.title', 'Rename Chat')}
          </DialogTitle>
          <DialogDescription className="leading-5">
            {t('sidebar.renameChat.description', 'Enter a new name for this chat.')}
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-4 sm:px-5">
          <Textarea
            ref={setTitleField}
            autoFocus
            rows={1}
            value={draft}
            disabled={saving}
            className="min-h-9 resize-none overflow-y-hidden py-2 leading-5 shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
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

        <DialogFooter className="border-t border-border/70 bg-muted/30 px-4 py-3 sm:px-5">
          <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={saving || normalizePlainTextTitle(draft).length === 0}
          >
            {t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameSessionDialog({ target, onClose }: RenameSessionDialogProps) {
  const { updateSessionTitle } = useSessionActions();

  return (
    <RenameSessionDialogView target={target} onClose={onClose} onRename={updateSessionTitle} />
  );
}
