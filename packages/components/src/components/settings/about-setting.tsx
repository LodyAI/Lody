import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import { CheckCircle2, AlertCircle, Download, ExternalLink } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Spinner } from '@lody/ui/spinner';
import type { ElectronUpdaterPhase } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Switch } from '@lody/ui/switch';
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
import { settingsType as type } from './type.stylex';

const buildInfo = collectClientBuildInfo();
const BUILD_DATE = buildInfo.buildDate ?? 'development';
const GIT_COMMIT = buildInfo.build ?? 'unknown';
const OSS_GIT_COMMIT = buildInfo.ossCommit ?? null;
const RELEASE_CHANNEL = buildInfo.releaseChannel ?? null;
// Build-time linked client version, injected by the web build. Used when there
// is no Electron updater state (i.e. on the web) so the About panel still shows
// a version number.
const APP_VERSION = buildInfo.appVersion || null;

const MONO = 'var(--font-mono, ui-monospace, monospace)';

const styles = stylex.create({
  /** A fact the build states: read, not set, so it is quiet and fixed-width. */
  value: { fontSize: type.caption, fontFamily: MONO, color: colors.secondaryLabel },
  status: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    fontSize: type.caption,
    color: colors.secondaryLabel,
  },
  statusError: { color: colors.destructive },
  statusIcon: { width: '14px', height: '14px', flexShrink: 0 },
  statusIconSuccess: { color: colors.success },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
  endpoints: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '2px',
    textAlign: 'end',
  },
  endpoint: { fontSize: type.caption, fontFamily: MONO, color: colors.secondaryLabel },
});

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
      <span {...stylex.props(styles.status)}>
        <CheckCircle2 {...stylex.props(styles.statusIcon, styles.statusIconSuccess)} />
        {t('settings.about.upToDate')}
      </span>
    );
  }

  if (phase === 'error') {
    return (
      <span {...stylex.props(styles.status, styles.statusError)}>
        <AlertCircle {...stylex.props(styles.statusIcon)} />
        {t('settings.about.updateError')}
      </span>
    );
  }

  if (phase === 'downloading') {
    const p = percent != null ? Math.round(percent) : 0;
    return (
      <span {...stylex.props(styles.status)}>
        <Spinner size="small" />
        {t('settings.about.downloading', { percent: String(p) })}
      </span>
    );
  }

  if (phase === 'disabled') {
    return <span {...stylex.props(styles.status)}>{t('settings.about.updaterDisabled')}</span>;
  }

  return null;
}

function DevbarSettingsControls() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<DevbarConfig | null>(null);
  const [warmup, setWarmup] = useState<{ enabled: boolean } | null>(null);
  const [supported, setSupported] = useState(true);
  const [pending, setPending] = useState(false);
  const [warmupPending, setWarmupPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const app = getIpcServices()?.app;
    if (!app) {
      setSupported(false);
      return undefined;
    }
    let disposed = false;
    void Promise.all([app.getDevbarConfig(), app.getWindowWarmup()])
      .then(([next, nextWarmup]) => {
        if (disposed) return;
        setConfig(next);
        setWarmup(nextWarmup);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const update = useCallback(async (enabled: boolean) => {
    const app = getIpcServices()?.app;
    if (!app) return;
    setPending(true);
    setFailed(false);
    try {
      const result = await app.setDevbarControl({ enabled });
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
  }, []);

  const updateWarmup = useCallback(async (enabled: boolean) => {
    const app = getIpcServices()?.app;
    if (!app) return;
    setWarmupPending(true);
    try {
      // Unlike the Devbar toggle this never reloads the window, so the pending
      // state settles with the IPC call itself.
      const result = await app.setWindowWarmup(enabled);
      if (result.ok) setWarmup({ enabled: result.enabled });
    } finally {
      setWarmupPending(false);
    }
  }, []);

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
          variant="secondary"
          size="small"
          disabled={!config || pending}
          onClick={() => void update(!config?.enabled)}
        >
          {pending && <Spinner size="small" />}
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
          checked={warmup?.enabled ?? false}
          disabled={!warmup || pending || warmupPending}
          onCheckedChange={(checked) => void updateWarmup(checked)}
          aria-label={t('settings.about.devbarWarmup', 'Auxiliary window warmup')}
        />
      </CompactRow>
      {config?.enabled && config.devframe && (
        <CompactRow
          label={t('settings.about.devbarAgentConnect', 'Agent connection')}
          helper={t(
            'settings.about.devbarAgentConnectHelper',
            'Run `devframe connect` to proxy this Hub to coding agents over stdio MCP, or use the endpoints below directly.'
          )}
        >
          <div {...stylex.props(styles.endpoints)}>
            <code {...stylex.props(styles.endpoint)}>{config.devframe.uiUrl}</code>
            {config.devframe.mcpUrl && (
              <code {...stylex.props(styles.endpoint)}>{config.devframe.mcpUrl}</code>
            )}
          </div>
        </CompactRow>
      )}
      {failed && (
        <CompactRow label={t('settings.about.devbar', 'Lody Devbar')}>
          <span {...stylex.props(styles.status, styles.statusError)}>
            <AlertCircle {...stylex.props(styles.statusIcon)} />
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
            <span {...stylex.props(styles.value)}>{displayVersion}</span>
          </CompactRow>
        )}
        <CompactRow label={t('settings.about.buildDate')}>
          <span {...stylex.props(styles.value)}>{formatBuildDate(BUILD_DATE)}</span>
        </CompactRow>
        {RELEASE_CHANNEL !== null && (
          <CompactRow label={t('settings.about.releaseChannel')}>
            <span {...stylex.props(styles.value)}>
              {t(`settings.about.channel.${RELEASE_CHANNEL}`)}
            </span>
          </CompactRow>
        )}
        <CompactRow
          label={t(
            OSS_GIT_COMMIT !== null ? 'settings.about.cloudCommit' : 'settings.about.commitHash'
          )}
        >
          <span {...stylex.props(styles.value)} title={GIT_COMMIT}>
            {GIT_COMMIT.slice(0, 8)}
          </span>
        </CompactRow>
        {OSS_GIT_COMMIT !== null && (
          <CompactRow label={t('settings.about.ossCommit')}>
            <span {...stylex.props(styles.value)} title={OSS_GIT_COMMIT}>
              {OSS_GIT_COMMIT.slice(0, 8)}
            </span>
          </CompactRow>
        )}
        <CompactRow label={t('settings.about.community', 'Community')}>
          <JoinCommunityButton />
        </CompactRow>
        <CompactRow label={t('settings.about.downloadApps', 'Download apps')}>
          <Button variant="secondary" size="small" onClick={handleOpenDownloadPage}>
            <ExternalLink {...stylex.props(styles.icon)} />
            {t('settings.about.openDownloadPage', 'Open download page')}
          </Button>
        </CompactRow>
        <CompactRow label={t('settings.about.downloadNightly')}>
          <Button
            variant="secondary"
            size="small"
            onClick={() => void openExternalUrl(getNightlyDownloadPageUrl(i18n.resolvedLanguage))}
          >
            <ExternalLink {...stylex.props(styles.icon)} />
            {t('settings.about.openDownloadPage', 'Open download page')}
          </Button>
        </CompactRow>
        <CompactRow label={t('settings.about.website', 'Website')}>
          <Button variant="secondary" size="small" onClick={handleOpenWebsite}>
            <ExternalLink {...stylex.props(styles.icon)} />
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
                  void getIpcServices()?.app.setDevbarControl({ enabled: false });
                  void getIpcServices()?.app.setWindowWarmup(false);
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
              <span {...stylex.props(styles.status, styles.statusError)} title={updaterState.error}>
                <AlertCircle {...stylex.props(styles.statusIcon)} />
                {t('settings.about.updateError')}
              </span>
            )}
            {isDownloaded ? (
              <Button
                size="small"
                onClick={() => {
                  void handleQuitAndInstall();
                }}
                disabled={isInstalling}
              >
                {isInstalling ? (
                  <Spinner size="small" />
                ) : (
                  <Download {...stylex.props(styles.icon)} />
                )}
                {t('settings.about.updateAndRestart')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void handleCheckForUpdates();
                }}
                disabled={isChecking || phase === 'downloading'}
              >
                {isChecking && <Spinner size="small" />}
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
