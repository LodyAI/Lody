import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getInlineReferenceUrl, parseBrowserPageReference } from '@lody/shared';
import { PopoverContent } from '@/ui/popover';
import { openExternalUrl } from '@/lib/native-browser';
import { requestBrowserPageReferenceOpen } from '@/lib/browser-page-reference';
import { writeTextToClipboard } from '@/lib/clipboard';
import { useRouter } from '@tanstack/react-router';

export function InlineReferenceActions({
  kind,
  target,
  onRemove,
  onClose,
  returnFocus,
}: {
  kind: string;
  target: string;
  onRemove?: () => void;
  onClose?: () => void;
  returnFocus?: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const url = getInlineReferenceUrl(kind, target);
  const failed = () =>
    toast.error(t('mention.reference.actionFailed', 'Could not complete this action'));
  const open = async () => {
    if (!url) return;
    if (kind === 'browser_page') {
      const reference = parseBrowserPageReference(target);
      const pathname = router?.state.location.pathname;
      if (reference && pathname) requestBrowserPageReferenceOpen(reference, pathname);
      else failed();
    } else if (!(await openExternalUrl(url))) failed();
    onClose?.();
  };
  const copy = async () => {
    if (!url) return;
    if (await writeTextToClipboard(url)) onClose?.();
    else failed();
  };
  const buttonClass =
    'w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none';
  return (
    <PopoverContent
      className="w-72 p-1"
      align="start"
      onCloseAutoFocus={
        returnFocus
          ? (event) => {
              event.preventDefault();
              returnFocus();
            }
          : undefined
      }
    >
      <p className="break-all px-2 py-1.5 text-xs text-muted-foreground">
        {url ?? t('mention.reference.unavailable', 'Reference unavailable')}
      </p>
      <button type="button" className={buttonClass} disabled={!url} onClick={() => void open()}>
        {kind === 'browser_page'
          ? t('mention.reference.openPage', 'Open browser page')
          : t('mention.reference.openUrl', 'Open link')}
      </button>
      <button type="button" className={buttonClass} disabled={!url} onClick={() => void copy()}>
        {t('mention.reference.copyUrl', 'Copy URL')}
      </button>
      {onRemove ? (
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            onRemove();
            onClose?.();
          }}
        >
          {t('mention.reference.remove', 'Remove reference')}
        </button>
      ) : null}
    </PopoverContent>
  );
}
