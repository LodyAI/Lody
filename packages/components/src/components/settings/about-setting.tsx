import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import { Loader2, CheckCircle2, AlertCircle, Download, ExternalLink } from 'lucide-react';
import type { ElectronUpdaterPhase } from '@lody/shared';
import { Button } from '@/ui/button';
import { Switch } from '@/ui/switch';
import { BetaFeaturesSection } from './beta-features-setting';
import { CompactRow, CompactSection } from './compact-layout';
import { settingContainerClass } from '.';
import { useElectronUpdaterState } from '@/hooks/use-electron-updater-state';
import { OpenSourceAttributionsDialog } from './open-source-attributions-dialog';
import { JoinCommunityButton } from './join-community-dialog';
import { openExternalUrl } from '@/lib/native-browser';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { getDownloadPageUrl, getWebsiteUrl } from '@/lib/lody-urls';
import { developerModeEnabledAtom } from '@/atoms/settings';
import { useIsMobile } from '@/hooks/use-mobile';
import { MobileAboutSettings } from '@/components/mobile/mobile-about-settings';

const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : 'development';
const GIT_COMMIT = typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'unknown';
// Build-time linked client version, injected by the web build. Used when there
// is no Electron updater state (i.e. on the web) so the About panel still shows
// a version number.
const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__.length > 0 ? __APP_VERSION__ : null;

function formatBuildDate(isoDate: string): string {
  if (isoDate === 'development') {
    return isoDate;
  }
  try {
    return new Date(isoDate).toLocaleString();
  } catch {
    return isoDate;
  }
}

function UpdateStatusText({
  phase,
  percent,
  t,
}: {
  phase: ElectronUpdaterPhase;
  percent?: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (phase === 'up_to_date') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-status-success" />
        {t('settings.about.upToDate')}
      </span>
    );
  }

  if (phase === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5" />
        {t('settings.about.updateError')}
      </span>
    );
  }

  if (phase === 'downloading') {
    const p = percent != null ? Math.round(percent) : 0;
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('settings.about.downloading', { percent: String(p) })}
      </span>
    );
  }

  if (phase === 'disabled') {
    return (
      <span className="text-xs text-muted-foreground">{t('settings.about.updaterDisabled')}</span>
    );
  }

  return null;
}

export function AboutSettingsComponent() {
  const { t, i18n } = useTranslation();
  const updaterState = useElectronUpdaterState();
  const [isInstalling, setIsInstalling] = useState(false);
  const [developerModeEnabled, setDeveloperModeEnabled] = useAtom(developerModeEnabledAtom);
  const [developerModeRevealed, setDeveloperModeRevealed] = useState(false);
  const isMobile = useIsMobile();

  const handleOpenDownloadPage = useCallback(() => {
    const url = getDownloadPageUrl(i18n.resolvedLanguage);
    void openExternalUrl(url);
  }, [i18n.resolvedLanguage]);

  const handleOpenWebsite = useCallback(() => {
    const url = getWebsiteUrl(i18n.resolvedLanguage);
    void openExternalUrl(url);
  }, [i18n.resolvedLanguage]);

  const handleCheckForUpdates = useCallback(async () => {
    if (!getIpcServices()) return;
    await getIpcServices()!.updater.checkForUpdates();
  }, []);

  const handleQuitAndInstall = useCallback(async () => {
    if (!getIpcServices()) return;
    setIsInstalling(true);
    const result = await getIpcServices()!.updater.quitAndInstall();
    if (!result.ok) {
      setIsInstalling(false);
    }
  }, []);

  const phase = updaterState?.phase;
  const isChecking = phase === 'checking';
  const isDownloaded = phase === 'downloaded';
  const showStatus =
    phase === 'up_to_date' || phase === 'error' || phase === 'downloading' || phase === 'disabled';
  const showDeveloperModeSwitch = developerModeEnabled || developerModeRevealed;
  // Electron reports its running version through the updater; on the web there
  // is no updater, so fall back to the build-time linked client version.
  const displayVersion = updaterState?.currentVersion ?? APP_VERSION;

  if (isMobile) return <MobileAboutSettings />;

  return (
    <div className={settingContainerClass}>
      <CompactSection>
        {displayVersion && (
          <CompactRow label={t('settings.about.version')}>
            <span className="text-sm text-muted-foreground font-mono">{displayVersion}</span>
          </CompactRow>
        )}
        <CompactRow label={t('settings.about.buildDate')}>
          <span className="text-sm text-muted-foreground font-mono">
            {formatBuildDate(BUILD_DATE)}
          </span>
        </CompactRow>
        <CompactRow label={t('settings.about.commitHash')}>
          <span className="text-sm text-muted-foreground font-mono">{GIT_COMMIT}</span>
        </CompactRow>
        <CompactRow label={t('settings.about.community', 'Community')}>
          <JoinCommunityButton />
        </CompactRow>
        <CompactRow label={t('settings.about.downloadApps', 'Download apps')}>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5"
            onClick={handleOpenDownloadPage}
          >
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            {t('settings.about.openDownloadPage', 'Open download page')}
          </Button>
        </CompactRow>
        <CompactRow label={t('settings.about.website', 'Website')}>
          <Button variant="outline" size="sm" className="h-7 px-2.5" onClick={handleOpenWebsite}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            {t('settings.about.visitWebsite', 'Visit website')}
          </Button>
        </CompactRow>
        <CompactRow label={t('settings.about.openSourceAttributions', 'Open Source Licenses')}>
          <OpenSourceAttributionsDialog
            onTriggerDoubleClick={() => setDeveloperModeRevealed(true)}
          />
        </CompactRow>
        {showDeveloperModeSwitch && (
          <CompactRow
            label={t('settings.about.developerMode', 'Developer mode')}
            helper={t(
              'settings.about.developerModeHelper',
              'Shows local diagnostic controls in settings.'
            )}
          >
            <Switch
              checked={developerModeEnabled}
              onCheckedChange={(checked) => {
                setDeveloperModeEnabled(checked);
                if (!checked) {
                  setDeveloperModeRevealed(false);
                }
              }}
              aria-label={t('settings.about.developerMode', 'Developer mode')}
            />
          </CompactRow>
        )}
        {updaterState && phase !== 'disabled' && (
          <CompactRow label={t('settings.about.checkForUpdates')}>
            {showStatus && <UpdateStatusText phase={phase} percent={updaterState.percent} t={t} />}
            {isDownloaded && updaterState.error && (
              <span
                className="flex items-center gap-1 text-xs text-destructive"
                title={updaterState.error}
              >
                <AlertCircle className="h-3.5 w-3.5" />
                {t('settings.about.updateError')}
              </span>
            )}
            {isDownloaded ? (
              <Button
                size="sm"
                className="h-7 px-2.5"
                onClick={() => {
                  void handleQuitAndInstall();
                }}
                disabled={isInstalling}
              >
                {isInstalling ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1 h-3.5 w-3.5" />
                )}
                {t('settings.about.updateAndRestart')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5"
                onClick={() => {
                  void handleCheckForUpdates();
                }}
                disabled={isChecking || phase === 'downloading'}
              >
                {isChecking && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                {t('settings.about.checkForUpdates')}
              </Button>
            )}
          </CompactRow>
        )}
      </CompactSection>
      <BetaFeaturesSection />
    </div>
  );
}
