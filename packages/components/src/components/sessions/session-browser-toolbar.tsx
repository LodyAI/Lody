import { useEffect, useRef, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, MessageCircle, Power, RefreshCw, Share2, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';

import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Toggle } from '@lody/ui/toggle';
import { Tooltip } from '@lody/ui/tooltip';
import {
  PreviewConnectionStatus,
  type PreviewConnectionStatusProps,
} from './preview-connection-status';

const styles = stylex.create({
  toolbarButton: { flexShrink: 0 },
  annotationMark: { color: colors.accent },
  toolbar: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: '2px',
    paddingInline: '6px',
    paddingBottom: '6px',
    paddingTop: 'calc(0.375rem + var(--safe-area-top))',
  },
  form: { minWidth: 0, flex: '1 1 0%', paddingInline: '4px' },
  addressInput: { minWidth: 0, width: '100%' },
  statusSlot: { display: 'flex', flexShrink: 0, alignItems: 'center', marginInlineEnd: '2px' },
  icon: { width: '16px', height: '16px' },
});

type SessionBrowserToolbarProps = {
  leadingSlot?: ReactNode;
  focusAddress?: boolean;
  address: string;
  previewStatus?: PreviewConnectionStatusProps;
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
  xstyle,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            icon
            className={className}
            xstyle={[styles.toolbarButton, xstyle]}
            aria-label={label}
            {...props}
          >
            {children}
          </Button>
        }
      />
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}

export function SessionBrowserToolbar({
  leadingSlot,
  focusAddress = false,
  address,
  previewStatus,
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

  const annotationLabel = annotationAvailable
    ? annotationEnabled
      ? t('sessions.browser.annotationDisable', 'Exit annotation mode')
      : t('sessions.browser.annotationEnable', 'Annotate page')
    : t(
        'sessions.browser.annotationManagedOnly',
        'Annotation is available only for local and private-network pages'
      );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onNavigate();
  };

  return (
    <Tooltip.Provider delay={350}>
      {/* Pad for the notch on mobile full-screen drawers; desktop keeps
         `--safe-area-top: 0` so the bar height is unchanged. */}
      <div {...stylex.props(styles.toolbar)}>
        {leadingSlot}
        <ToolbarButton
          label={t('sessions.browser.back', 'Back')}
          disabled={!canGoBack || busy}
          onClick={onBack}
        >
          <ArrowLeft {...stylex.props(styles.icon)} />
        </ToolbarButton>
        <ToolbarButton
          label={t('sessions.browser.forward', 'Forward')}
          disabled={!canGoForward || busy}
          onClick={onForward}
        >
          <ArrowRight {...stylex.props(styles.icon)} />
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
          {loading ? (
            <X {...stylex.props(styles.icon)} />
          ) : (
            <RefreshCw {...stylex.props(styles.icon)} />
          )}
        </ToolbarButton>

        <form {...stylex.props(styles.form)} onSubmit={submit}>
          <Input
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
            xstyle={styles.addressInput}
            trailing={
              previewStatus ? (
                <div {...stylex.props(styles.statusSlot)}>
                  <PreviewConnectionStatus {...previewStatus} />
                </div>
              ) : undefined
            }
          />
        </form>

        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Toggle
                icon
                type="button"
                pressed={annotationEnabled}
                disabled={!annotationAvailable || busy}
                aria-label={annotationLabel}
                onPressedChange={onToggleAnnotation}
              >
                <MessageCircle
                  {...stylex.props(styles.icon, annotationEnabled && styles.annotationMark)}
                />
              </Toggle>
            }
          />
          <Tooltip.Content>{annotationLabel}</Tooltip.Content>
        </Tooltip.Root>
        <ToolbarButton
          label={
            hasShareUrl
              ? t('sessions.browser.copyShareUrl', 'Copy share URL')
              : t('sessions.browser.share', 'Share preview')
          }
          disabled={!shareAvailable || busy}
          onClick={onShare}
        >
          {sharing ? (
            <Spinner label={null} size="small" />
          ) : (
            <Share2 {...stylex.props(styles.icon)} />
          )}
        </ToolbarButton>
        {hasShareUrl ? (
          <ToolbarButton
            label={t('sessions.browser.stopSharing', 'Stop sharing')}
            disabled={busy}
            onClick={onStopSharing}
          >
            <Power {...stylex.props(styles.icon)} />
          </ToolbarButton>
        ) : null}
      </div>
    </Tooltip.Provider>
  );
}
