import type { ComponentProps, ReactNode } from 'react';
import { Globe2, ShieldAlert } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { SessionBrowserToolbar } from './session-browser-toolbar';
import {
  PreviewConnectionPlaceholder,
  type PreviewConnectionStatusProps,
} from './preview-connection-status';

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    backgroundColor: colors.background,
  },
  error: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: `color-mix(in oklab, ${colors.destructive} 30%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 8%, transparent)`,
    paddingInline: '12px',
    paddingBlock: '8px',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    color: colors.destructive,
  },
  errorIcon: { flexShrink: 0, width: '14px', height: '14px', marginTop: '2px' },
  errorText: { minWidth: 0, overflowWrap: 'break-word' },
  progress: {
    display: 'flex',
    flex: '1 1 0%',
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    backgroundColor: colors.background,
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    color: colors.secondaryLabel,
  },
  empty: {
    display: 'flex',
    flex: '1 1 0%',
    minHeight: 0,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    backgroundColor: colors.background,
    paddingInline: '24px',
    textAlign: 'center',
  },
  emptyIcon: {
    width: '28px',
    height: '28px',
    color: `color-mix(in oklab, ${colors.secondaryLabel} 60%, transparent)`,
  },
  emptyText: {
    maxWidth: '20rem',
    margin: 0,
    fontSize: '0.75rem',
    lineHeight: '1rem',
    color: colors.secondaryLabel,
  },
});

export type ManagedNavigationPhase = 'resolving-machine' | 'opening-local' | 'creating-tunnel';

type SessionBrowserPanelViewProps = {
  className?: string;
  toolbar: ComponentProps<typeof SessionBrowserToolbar>;
  previewStatus?: PreviewConnectionStatusProps;
  error?: string | null;
  onDismissError: () => void;
  navigationPhase?: ManagedNavigationPhase | null;
  suggestedAddress?: string;
  children?: ReactNode;
};

/** Presentation only. The controller owns navigation, authorization and endpoint lifetime. */
export function SessionBrowserPanelView({
  className,
  toolbar,
  previewStatus,
  error,
  onDismissError,
  navigationPhase,
  suggestedAddress,
  children,
}: SessionBrowserPanelViewProps) {
  const { t } = useTranslation();
  const hasContent = Boolean(children);
  // When remote content is absent the placeholder owns the single recovery
  // action; keeping it out of the popover avoids two simultaneous Restore
  // buttons. Local/connected content has no placeholder, so the popover owns it.
  const toolbarPreviewStatus =
    previewStatus && hasContent
      ? previewStatus
      : previewStatus && { ...previewStatus, onRestore: undefined, onStopSharing: undefined };
  const previewDiagnostic =
    previewStatus?.unavailableReason ??
    previewStatus?.error ??
    previewStatus?.connection?.error?.message ??
    null;
  const showErrorBanner =
    Boolean(error) && !(previewStatus && !hasContent && previewDiagnostic === error);
  const rootStyle = stylex.props(styles.root);
  return (
    <div {...rootStyle} className={[rootStyle.className, className].filter(Boolean).join(' ')}>
      <SessionBrowserToolbar {...toolbar} previewStatus={toolbarPreviewStatus} />
      {showErrorBanner ? (
        <div role="alert" {...stylex.props(styles.error)}>
          <ShieldAlert {...stylex.props(styles.errorIcon)} />
          <span {...stylex.props(styles.errorText)}>{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            className="ml-auto"
            onClick={onDismissError}
          >
            {t('common.dismiss', 'Dismiss')}
          </Button>
        </div>
      ) : null}
      {navigationPhase && !hasContent ? (
        <div role="status" aria-live="polite" {...stylex.props(styles.progress)}>
          <Spinner label={null} size="small" />
          <span>
            {navigationPhase === 'resolving-machine'
              ? t('sessions.browser.resolvingMachine', 'Resolving the session machine…')
              : navigationPhase === 'creating-tunnel'
                ? t('sessions.browser.creatingTunnel', 'Establishing a secure preview connection…')
                : t('sessions.browser.openingLocal', 'Opening the local preview…')}
          </span>
        </div>
      ) : (
        (children ??
        (previewStatus ? (
          <PreviewConnectionPlaceholder {...previewStatus} />
        ) : (
          <div {...stylex.props(styles.empty)}>
            <Globe2 {...stylex.props(styles.emptyIcon)} aria-hidden />
            <p {...stylex.props(styles.emptyText)}>
              {suggestedAddress
                ? t('sessions.browser.emptyWithCandidate', 'Press Enter to open {{url}}', {
                    url: suggestedAddress,
                  })
                : t(
                    'sessions.browser.emptyNoCandidate',
                    'No preview address reported yet. Enter a URL above, or ask the agent to report its dev server.'
                  )}
            </p>
          </div>
        )))
      )}
    </div>
  );
}
