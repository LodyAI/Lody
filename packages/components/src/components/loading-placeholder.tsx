import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { Spinner } from '@lody/ui/spinner';
import { BootLoadingIndicator, BootShell } from '@/components/boot-shell';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeSpace,
} from '../style/theme-scale.stylex';

const styles = stylex.create({
  content: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    minHeight: 0,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'hsl(var(--background))',
    color: colors.secondaryLabel,
  },
  viewport: {
    display: 'flex',
    minHeight: '100dvh',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: themeColors.background,
    padding: themeSpace[6],
    color: themeColors.mutedForeground,
  },
  column: {
    display: 'flex',
    maxWidth: '24rem',
    flexDirection: 'column',
    alignItems: 'center',
    gap: themeSpace[3],
    textAlign: 'center',
  },
  /**
   * `space-y-1` between the title and the description: the description sits one
   * step below the title, and the last statement gives the step back.
   */
  title: {
    marginBottom: { default: themeSpace[1], ':last-child': 0 },
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  description: {
    marginInline: 'auto',
    maxWidth: '320px',
    fontSize: themeFontSize.xs,
    lineHeight: themeSpace[5],
  },
});

export function LoadingPlaceholder({
  title = 'Loading',
  description = '',
  variant = 'viewport',
}: {
  title?: string;
  description?: string;
  /**
   * `boot` is for the boot/auth gates between the window's first frame and the
   * workspace layout: it continues the boot shell painted by `index.html`, with
   * this copy under the mark. `viewport` fills the viewport where that frame is
   * not continued. `content` fills an already-mounted workspace pane so the
   * sidebar and workspace identity remain stable during scoped synchronization.
   */
  variant?: 'boot' | 'viewport' | 'content';
}) {
  if (variant === 'boot') {
    return (
      <BootShell
        status={
          <>
            <div className="lody-boot-shell__status-title">{title}</div>
            {description ? <div>{description}</div> : null}
          </>
        }
      />
    );
  }

  if (variant === 'content') {
    return (
      <div {...stylex.props(styles.content)} data-loading-placeholder-scope="content">
        <BootLoadingIndicator
          status={
            <>
              <div className="lody-boot-shell__status-title">{title}</div>
              {description ? <div>{description}</div> : null}
            </>
          }
        />
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.viewport)} data-loading-placeholder-scope={variant}>
      <div {...stylex.props(styles.column)} role="status" aria-live="polite">
        <Spinner diameter="calc(var(--spacing) * 5)" aria-hidden />
        <div>
          <div {...stylex.props(styles.title)}>{title}</div>
          {description ? <div {...stylex.props(styles.description)}>{description}</div> : null}
        </div>
      </div>
    </div>
  );
}
