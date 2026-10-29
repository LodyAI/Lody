import { useTranslation } from 'react-i18next';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import { Progress } from '@lody/ui/progress';
import * as stylex from '@stylexjs/stylex';
import type { UpdateBannerState } from '@/lib/electron-update-banner';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../style/theme-scale.stylex';

const styles = stylex.create({
  pendingSpinnerSpacing: { marginRight: 'calc(var(--spacing) * 1.5)' },
  banner: {
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.8)',
    // A frosted panel: opaque where the platform cannot blur, translucent where
    // it can.
    backgroundColor: {
      default: 'hsl(var(--background) / 0.95)',
      '@supports (backdrop-filter: var(--tw))': 'hsl(var(--background) / 0.85)',
    },
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    boxShadow: themeShadow.lg,
    backdropFilter: 'blur(8px)',
  },
  title: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.semibold,
    color: themeColors.foreground,
  },
  description: {
    marginTop: themeSpace[1],
    fontSize: themeFontSize.xs,
    lineHeight: 1.625,
    color: themeColors.mutedForeground,
  },
  progressRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    marginTop: themeSpace[2],
  },
  percent: {
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    color: themeColors.mutedForeground,
  },
  changelog: {
    display: 'inline-flex',
    marginTop: themeSpace[1],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    fontWeight: themeFontWeight.medium,
    color: themeColors.primary,
    textUnderlineOffset: '2px',
    textDecorationLine: { default: 'none', ':hover': 'underline' },
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: themeSpace[2],
    marginTop: themeSpace[2],
  },
});

/**
 * Floating sidebar notice for a desktop update that is downloading or ready to
 * install. `View changelog` opens the in-app changelog dialog; it must never
 * leave the app on its own.
 */
export function SidebarUpdateBanner({
  stage,
  version,
  percent,
  isRestarting,
  onViewChangelog,
  onRestart,
  onLater,
}: UpdateBannerState & {
  isRestarting: boolean;
  onViewChangelog: () => void;
  onRestart: () => void;
  onLater: () => void;
}) {
  const { t } = useTranslation();
  const isDownloading = stage === 'downloading';

  return (
    <div {...stylex.props(styles.banner)}>
      <div {...stylex.props(styles.title)}>
        {isDownloading
          ? t('sidebar.updateDownloading.title', 'Downloading update')
          : t('sidebar.updateReady.title', 'Update ready')}
      </div>
      <div {...stylex.props(styles.description)}>
        {isDownloading
          ? t(
              'sidebar.updateDownloading.description',
              'Version {{version}} is downloading in the background.',
              { version }
            )
          : t('sidebar.updateReady.description', 'Restart to update to {{version}}.', { version })}
      </div>
      {isDownloading && percent != null ? (
        <div {...stylex.props(styles.progressRow)}>
          <Progress value={percent} className="h-1 flex-1" />
          <span {...stylex.props(styles.percent)}>
            {t('sidebar.updateDownloading.percent', '{{percent}}%', { percent })}
          </span>
        </div>
      ) : null}
      <button type="button" onClick={onViewChangelog} {...stylex.props(styles.changelog)}>
        {t('sidebar.updateReady.changelog', 'View changelog')}
      </button>
      <div {...stylex.props(styles.actions)}>
        <Button
          type="button"
          variant="ghost"
          size="small"
          height="calc(var(--spacing) * 7)"
          className="px-2.5"
          onClick={onLater}
        >
          {t('sidebar.updateReady.later', 'Later')}
        </Button>
        {isDownloading ? null : (
          <Button
            type="button"
            size="small"
            height="calc(var(--spacing) * 7)"
            className="px-2.5"
            onClick={onRestart}
          >
            {isRestarting ? (
              <Spinner
                diameter="calc(var(--spacing) * 3.5)"
                className={stylex.props(styles.pendingSpinnerSpacing).className}
              />
            ) : null}
            {t('sidebar.updateReady.restart', 'Update & Restart')}
          </Button>
        )}
      </div>
    </div>
  );
}
