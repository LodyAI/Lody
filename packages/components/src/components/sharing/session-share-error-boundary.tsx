import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  page: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100dvh',
    padding: space[8],
    textAlign: 'center',
    backgroundColor: colors.background,
    color: colors.label,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[3],
    maxWidth: '384px',
  },
  title: {
    margin: 0,
    fontSize: text.titleSize,
    lineHeight: text.titleLeading,
    fontWeight: 600,
    color: colors.label,
  },
  detail: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
  },
});

export function SessionShareReadError() {
  const { t } = useTranslation();
  return (
    <main {...stylex.props(styles.page)} role="alert">
      <div {...stylex.props(styles.content)}>
        <h1 {...stylex.props(styles.title)}>
          {t('sharing.renderError', 'This conversation could not be displayed')}
        </h1>
        <p {...stylex.props(styles.detail)}>
          {t(
            'sharing.renderErrorDetail',
            'The shared document may contain unsupported content. Try reloading the page.'
          )}
        </p>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          {t('sharing.reloadPage', 'Reload page')}
        </Button>
      </div>
    </main>
  );
}

/** Unmounting the reader closes its transport and attachments. No error payload,
 * content or fragment is retained/reported; recovery is an explicit user action.
 * The app's ordinary boundary imports telemetry and cannot be used by this entry.
 */
export class SessionShareErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <SessionShareReadError /> : this.props.children;
  }
}
