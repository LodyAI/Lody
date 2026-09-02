import { useEffect, useRef, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  MessageCircle,
  Monitor,
  Power,
  RefreshCw,
  Share2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@lody/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { cn } from '@/lib/utils';

type SessionBrowserToolbarProps = {
  leadingSlot?: ReactNode;
  focusAddress?: boolean;
  address: string;
  remoteMachineName?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  annotationEnabled: boolean;
  annotationAvailable: boolean;
  sharing: boolean;
  shareAvailable: boolean;
  hasShareUrl: boolean;
  busy: boolean;
  onAddressChange: (address: string) => void;
  onRestoreAddress: () => void;
  onNavigate: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onToggleAnnotation: () => void;
  onShare: () => void;
  onStopSharing: () => void;
};

function ToolbarButton({
  label,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          icon
          className={cn('shrink-0', className)}
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function SessionBrowserToolbar({
  leadingSlot,
  focusAddress = false,
  address,
  remoteMachineName,
  canGoBack,
  canGoForward,
  loading,
  annotationEnabled,
  annotationAvailable,
  sharing,
  shareAvailable,
  hasShareUrl,
  busy,
  onAddressChange,
  onRestoreAddress,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onToggleAnnotation,
  onShare,
  onStopSharing,
}: SessionBrowserToolbarProps) {
  const { t } = useTranslation();
  const addressInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusAddress) addressInputRef.current?.focus();
  }, [focusAddress]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onNavigate();
  };

  return (
    <TooltipProvider delayDuration={350}>
      {/* Pad for the notch on mobile full-screen drawers; desktop keeps
         `--safe-area-top: 0` so the bar height is unchanged. */}
      <div className="flex min-w-0 items-center gap-0.5 border-b border-border bg-background px-1.5 pb-1.5 pt-[calc(0.375rem+var(--safe-area-top))]">
        {leadingSlot}
        <ToolbarButton
          label={t('sessions.browser.back', 'Back')}
          disabled={!canGoBack || busy}
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          label={t('sessions.browser.forward', 'Forward')}
          disabled={!canGoForward || busy}
          onClick={onForward}
        >
          <ArrowRight className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          label={
            loading
              ? t('sessions.browser.stop', 'Stop loading')
              : t('sessions.browser.reload', 'Reload')
          }
          disabled={busy}
          onClick={loading ? onStop : onReload}
        >
          {loading ? <X className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
        </ToolbarButton>

        <form className="min-w-0 flex-1 px-1" onSubmit={submit}>
          <div className="flex h-8 min-w-0 items-center rounded-md border border-input-border bg-input-field transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
            <input
              ref={addressInputRef}
              type="text"
              inputMode="url"
              value={address}
              onChange={(event) => onAddressChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onRestoreAddress();
                  event.currentTarget.blur();
                }
              }}
              placeholder={t('sessions.browser.addressPlaceholder', 'Enter a URL')}
              aria-label={t('sessions.browser.address', 'Address')}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
            {remoteMachineName ? (
              <span
                className="flex min-w-0 max-w-[40%] shrink-0 items-center gap-1 border-l border-input-border/70 px-2 text-[11px] text-muted-foreground"
                aria-label={`${t('sessions.browser.remoteMachine', 'Remote machine')}: ${remoteMachineName}`}
                title={remoteMachineName}
              >
                <Monitor className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{remoteMachineName}</span>
              </span>
            ) : null}
          </div>
        </form>

        <ToolbarButton
          label={
            annotationAvailable
              ? annotationEnabled
                ? t('sessions.browser.annotationDisable', 'Exit annotation mode')
                : t('sessions.browser.annotationEnable', 'Annotate page')
              : t(
                  'sessions.browser.annotationManagedOnly',
                  'Annotation is available only for local and private-network pages'
                )
          }
          className={annotationEnabled ? 'bg-accent text-accent-foreground' : undefined}
          disabled={!annotationAvailable || busy}
          aria-pressed={annotationEnabled}
          onClick={onToggleAnnotation}
        >
          <MessageCircle className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          label={
            hasShareUrl
              ? t('sessions.browser.copyShareUrl', 'Copy share URL')
              : t('sessions.browser.share', 'Share preview')
          }
          disabled={!shareAvailable || busy}
          onClick={onShare}
        >
          {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
        </ToolbarButton>
        {hasShareUrl ? (
          <ToolbarButton
            label={t('sessions.browser.stopSharing', 'Stop sharing')}
            disabled={busy}
            onClick={onStopSharing}
          >
            <Power className="h-4 w-4" />
          </ToolbarButton>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
