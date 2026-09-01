import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2, AlertCircle, Download, ExternalLink } from 'lucide-react';
import type { ElectronUpdaterPhase } from '@lody/shared';
import { useAtom } from 'jotai';
import { Button } from '@/ui/button';
import { Switch } from '@/ui/switch';
import {
  developerModeEnabledAtom,
  inboxBetaEnabledAtom,
  tasksBetaEnabledAtom,
} from '@/atoms/settings';
import { useElectronUpdaterState } from '@/hooks/use-electron-updater-state';
import { OpenSourceAttributionsDialog } from '@/components/settings/open-source-attributions-dialog';
import { JoinCommunityButton } from '@/components/settings/join-community-dialog';
import { openExternalUrl } from '@/lib/native-browser';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { getDownloadPageUrl, getWebsiteUrl } from '@/lib/lody-urls';
import { LODY_APP_INFO_UPDATED_EVENT, readNativeAppInfo } from '@/lib/native-app-info';
import {
  MobileSettingsRow,
  MobileSettingsRowGroup,
  MobileSettingsSection,
} from '@/components/mobile/mobile-settings-row';

function readNativeAppVersion(): string | null {
  const version = readNativeAppInfo().version;
  return typeof version === 'string' && version.trim().length > 0 ? version : null;
}

// Build-time linked client version injected by the web build (undefined in the
// native mobile build, where Capacitor's version takes precedence). Lets the
// narrow-web About panel — which renders this mobile layout — show a version.
const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__.length > 0 ? __APP_VERSION__ : null;
const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : 'development';
const GIT_COMMIT = typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'unknown';

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

/**
 * Taps on the commit-hash row needed to reveal the Developer mode switch. Desktop
 * hides the same switch behind a double-click on "View notices"; a webview
 * double-tap is unreliable (it competes with tap-to-zoom), so mobile uses the
 * gesture people already know from Android's build-number easter egg.
 *
 * Deliberately counted without a reset timer: a timeout would make the reveal
 * depend on wall-clock timing, which is exactly the kind of thing that turns
 * into a flaky test. Tapping a version number seven times is not something
 * anyone does by accident.
 */
const DEVELOPER_MODE_REVEAL_TAPS = 7;

export function MobileAboutSettings() {
  const { t, i18n } = useTranslation();
  const [developerModeEnabled, setDeveloperModeEnabled] = useAtom(developerModeEnabledAtom);
  const [tasksBetaEnabled, setTasksBetaEnabled] = useAtom(tasksBetaEnabledAtom);
  const [inboxBetaEnabled, setInboxBetaEnabled] = useAtom(inboxBetaEnabledAtom);
  const [revealTaps, setRevealTaps] = useState(0);
  const updaterState = useElectronUpdaterState();
  const [isInstalling, setIsInstalling] = useState(false);
  const [nativeAppVersion, setNativeAppVersion] = useState<string | null>(() =>
    readNativeAppVersion()
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const updateVersion = () => {
      setNativeAppVersion(readNativeAppVersion());
    };
    updateVersion();
    window.addEventListener(LODY_APP_INFO_UPDATED_EVENT, updateVersion);
    return () => {
      window.removeEventListener(LODY_APP_INFO_UPDATED_EVENT, updateVersion);
    };
  }, []);

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
  const aboutVersion = nativeAppVersion ?? updaterState?.currentVersion ?? APP_VERSION;
  const showDeveloperModeSwitch = developerModeEnabled || revealTaps >= DEVELOPER_MODE_REVEAL_TAPS;

  return (
    <>
      <MobileSettingsSection title={t('settings.about.title')}>
        <MobileSettingsRowGroup>
          {aboutVersion ? (
            <MobileSettingsRow label={t('settings.about.version')}>
              <span className="font-mono text-[0.85rem] text-muted-foreground">{aboutVersion}</span>
            </MobileSettingsRow>
          ) : null}
          <MobileSettingsRow label={t('settings.about.buildDate')}>
            <span className="font-mono text-[0.85rem] text-muted-foreground">
              {formatBuildDate(BUILD_DATE)}
            </span>
          </MobileSettingsRow>
          {/* The reveal target is the commit row, not the version row: the
             version row only renders when a version is known (absent on narrow
             web), which would leave the gesture unreachable exactly where the
             desktop panel is also unavailable. */}
          <MobileSettingsRow
            label={t('settings.about.commitHash')}
            onClick={() => setRevealTaps((count) => count + 1)}
          >
            <span className="font-mono text-[0.85rem] text-muted-foreground">{GIT_COMMIT}</span>
          </MobileSettingsRow>
        </MobileSettingsRowGroup>
      </MobileSettingsSection>

      <MobileSettingsSection title={t('settings.about.linksTitle', 'Links')}>
        <MobileSettingsRowGroup>
          <MobileSettingsRow label={t('settings.about.community', 'Community')}>
            <JoinCommunityButton />
          </MobileSettingsRow>
          <MobileSettingsRow
            label={t('settings.about.downloadApps', 'Download apps')}
            onClick={handleOpenDownloadPage}
            trailing={<ExternalLink className="h-4 w-4" />}
          />
          <MobileSettingsRow
            label={t('settings.about.website', 'Website')}
            onClick={handleOpenWebsite}
            trailing={<ExternalLink className="h-4 w-4" />}
          />
          {/* Dialog is self-contained (renders its own DialogTrigger button); we
             keep the trigger button in the row's right slot rather than making
             the entire row tappable so the dialog's controlled-open state stays
             owned by `OpenSourceAttributionsDialog` (no need to refactor it to
             accept external open/onOpenChange just for the mobile surface). */}
          <MobileSettingsRow
            label={t('settings.about.openSourceAttributions', 'Open Source Licenses')}
          >
            <OpenSourceAttributionsDialog />
          </MobileSettingsRow>
        </MobileSettingsRowGroup>
      </MobileSettingsSection>

      {updaterState && phase !== 'disabled' ? (
        <MobileSettingsSection title={t('settings.about.updatesTitle', 'Updates')}>
          <MobileSettingsRow
            label={t('settings.about.checkForUpdates')}
            helper={
              showStatus ? (
                <UpdateStatusText phase={phase} percent={updaterState.percent} t={t} />
              ) : undefined
            }
          >
            {isDownloaded ? (
              <Button
                size="sm"
                className="h-8 px-3"
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
                className="h-8 px-3"
                onClick={() => {
                  void handleCheckForUpdates();
                }}
                disabled={isChecking || phase === 'downloading'}
              >
                {isChecking ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {t('settings.about.checkForUpdates')}
              </Button>
            )}
          </MobileSettingsRow>
        </MobileSettingsSection>
      ) : null}

      {showDeveloperModeSwitch ? (
        <MobileSettingsSection title={t('settings.about.developerMode', 'Developer mode')}>
          <MobileSettingsRowGroup>
            <MobileSettingsRow
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
                  // Turning it off re-hides the section, matching desktop: the
                  // reveal has to be earned again.
                  if (!checked) setRevealTaps(0);
                }}
                aria-label={t('settings.about.developerMode', 'Developer mode')}
              />
            </MobileSettingsRow>
          </MobileSettingsRowGroup>
        </MobileSettingsSection>
      ) : null}

      {developerModeEnabled ? (
        <MobileSettingsSection title={t('settings.beta.title', 'Beta features')}>
          <MobileSettingsRowGroup>
            <MobileSettingsRow
              label={t('settings.beta.tasks', 'Tasks')}
              helper={t(
                'settings.beta.tasksHelper',
                'Track work you are not starting yet, separately from chats. In development — expect rough edges.'
              )}
            >
              <Switch
                checked={tasksBetaEnabled}
                onCheckedChange={setTasksBetaEnabled}
                aria-label={t('settings.beta.tasks', 'Tasks')}
              />
            </MobileSettingsRow>
            <MobileSettingsRow
              label={t('settings.beta.inbox', 'Inbox')}
              helper={t(
                'settings.beta.inboxHelper',
                'Show the unfinished mobile Inbox tab. In development — expect rough edges.'
              )}
            >
              <Switch
                checked={inboxBetaEnabled}
                onCheckedChange={setInboxBetaEnabled}
                aria-label={t('settings.beta.inbox', 'Inbox')}
              />
            </MobileSettingsRow>
          </MobileSettingsRowGroup>
        </MobileSettingsSection>
      ) : null}
    </>
  );
}
