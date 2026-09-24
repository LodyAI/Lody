import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import { CheckCircle2, AlertCircle, Download, ExternalLink } from 'lucide-react';
import { Spinner } from '@/ui/spinner';
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
import { getDownloadPageUrl, getNightlyDownloadPageUrl, getWebsiteUrl } from '@/lib/lody-urls';
import { developerModeEnabledAtom } from '@/atoms/settings';
import { useIsMobile } from '@/hooks/use-mobile';
import { MobileAboutSettings } from '@/components/mobile/mobile-about-settings';
import { collectClientBuildInfo } from '@/lib/client-build-info';

const buildInfo = collectClientBuildInfo();
const BUILD_DATE = buildInfo.buildDate ?? 'development';
const GIT_COMMIT = buildInfo.build ?? 'unknown';
const OSS_GIT_COMMIT = buildInfo.ossCommit ?? null;
const RELEASE_CHANNEL = buildInfo.releaseChannel ?? null;
// Build-time linked client version, injected by the web build. Used when there
// is no Electron updater state (i.e. on the web) so the About panel still shows
// a version number.
const APP_VERSION = buildInfo.appVersion || null;

type AppIpc = NonNullable<ReturnType<typeof getIpcServices>>['app'];
type DevbarConfig = Awaited<ReturnType<AppIpc['getDevbarConfig']>>;

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
        <Spinner className="h-3.5 w-3.5" />
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

function DevbarSettingsControls() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<DevbarConfig | null>(null);
  const [supported, setSupported] = useState(true);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const app = getIpcServices()?.app;
    if (!app) {
      setSupported(false);
      return undefined;
    }
    let disposed = false;
    void app
      .getDevbarConfig()
      .then((next) => {
        if (!disposed) setConfig(next);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const update = useCallback(
    async (enabled: boolean, agentAccess: boolean, warmupEnabled: boolean) => {
      const app = getIpcServices()?.app;
      if (!app) return;
      setPending(true);
      setFailed(false);
      try {
        const result = await app.setDevbarControl({ enabled, agentAccess, warmupEnabled });
        if (!result.ok) {
          setFailed(true);
          setPending(false);
          return;
        }
        setConfig(result.config);
        // The main process now reloads this window through the CSP-matched renderer
        // entry. Keep the control busy so it cannot dispatch a conflicting toggle.
      } catch {
        setFailed(true);
        setPending(false);
      }
    },
    []
  );

  if (!supported) return null;

  return (
    <>
      <CompactRow
        label={t('settings.about.devbar', 'Lody Devbar')}
        helper={t(
          'settings.about.devbarHelper',
          'Starts local performance diagnostics for this Lody session.'
        )}
      >
        <Button
          variant={config?.enabled ? 'outline' : 'default'}
          size="sm"
          className="h-7 px-2.5"
          disabled={!config || pending}
          onClick={() => void update(!config?.enabled, false, config?.warmupEnabled ?? false)}
        >
          {pending && <Spinner className="mr-1 h-3.5 w-3.5" />}
          {config?.enabled
            ? t('settings.about.devbarStop', 'Stop Devbar')
            : t('settings.about.devbarStart', 'Open Devbar')}
        </Button>
      </CompactRow>
      <CompactRow
        label={t('settings.about.devbarWarmup', 'Auxiliary window warmup')}
        helper={t(
          'settings.about.devbarWarmupHelper',
          'Developer-only experiment: keep one hidden renderer ready for auxiliary windows.'
        )}
      >
        <Switch
          checked={config?.warmupEnabled ?? false}
          disabled={!config || pending}
          onCheckedChange={(checked) =>
            void update(config?.enabled ?? false, config?.agentAccess ?? false, checked)
          }
          aria-label={t('settings.about.devbarWarmup', 'Auxiliary window warmup')}
        />
      </CompactRow>
      {config?.enabled && (
        <CompactRow
          label={t('settings.about.devbarAgentAccess', 'Agent and terminal access')}
          helper={t(
            'settings.about.devbarAgentAccessHelper',
            'Exposes local MCP and restricted subprocess tools until Devbar stops.'
          )}
        >
          <Switch
            checked={config.agentAccess}
            disabled={pending}
            onCheckedChange={(checked) => void update(true, checked, config.warmupEnabled)}
            aria-label={t('settings.about.devbarAgentAccess', 'Agent and terminal access')}
          />
        </CompactRow>
      )}
      {config?.enabled && config.agentAccess && config.devframe && (
        <CompactRow
          label={t('settings.about.devbarAgentConnect', 'Agent connection')}
          helper={t(
            'settings.about.devbarAgentConnectHelper',
            'Run `devframe connect` to proxy this Hub to coding agents over stdio MCP, or use the endpoints below directly.'
          )}
        >
          <div className="flex flex-col items-end gap-0.5 text-right">
            <code className="text-xs text-muted-foreground">{config.devframe.uiUrl}</code>
            {config.devframe.mcpUrl && (
              <code className="text-xs text-muted-foreground">{config.devframe.mcpUrl}</code>
            )}
          </div>
        </CompactRow>
      )}
      {failed && (
        <CompactRow label={t('settings.about.devbar', 'Lody Devbar')}>
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            {t('settings.about.devbarError', 'Devbar could not be started.')}
          </span>
        </CompactRow>
      )}
    </>
  );
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
        {RELEASE_CHANNEL !== null && (
          <CompactRow label={t('settings.about.releaseChannel')}>
            <span className="text-sm text-muted-foreground">
              {t(`settings.about.channel.${RELEASE_CHANNEL}`)}
            </span>
          </CompactRow>
        )}
        <CompactRow
          label={t(
            OSS_GIT_COMMIT !== null ? 'settings.about.cloudCommit' : 'settings.about.commitHash'
          )}
        >
          <span className="text-sm text-muted-foreground font-mono" title={GIT_COMMIT}>
            {GIT_COMMIT.slice(0, 8)}
          </span>
        </CompactRow>
        {OSS_GIT_COMMIT !== null && (
          <CompactRow label={t('settings.about.ossCommit')}>
            <span className="text-sm text-muted-foreground font-mono" title={OSS_GIT_COMMIT}>
              {OSS_GIT_COMMIT.slice(0, 8)}
            </span>
          </CompactRow>
        )}
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
        <CompactRow label={t('settings.about.downloadNightly')}>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5"
            onClick={() => void openExternalUrl(getNightlyDownloadPageUrl(i18n.resolvedLanguage))}
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
                  void getIpcServices()?.app.setDevbarControl({
                    enabled: false,
                    agentAccess: false,
                    warmupEnabled: false,
                  });
                }
              }}
              aria-label={t('settings.about.developerMode', 'Developer mode')}
            />
          </CompactRow>
        )}
        {developerModeEnabled && <DevbarSettingsControls />}
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
                  <Spinner className="mr-1 h-3.5 w-3.5" />
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
                {isChecking && <Spinner className="mr-1 h-3.5 w-3.5" />}
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
