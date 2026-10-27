import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertCircle, Download, ExternalLink } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import type { ElectronUpdaterPhase } from '@lody/shared';
import { useAtom } from 'jotai';
import { Button } from '@lody/ui/button';
import { Switch } from '@lody/ui/switch';
import {
  developerModeEnabledAtom,
  e2eeWorkspaceCreationEnabledAtom,
  inboxBetaEnabledAtom,
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
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  /** The updater's answer: a mark and one line of copy. */
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  statusError: { color: themeColors.destructive },
  /** The same copy, with no mark beside it. */
  statusQuiet: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  statusIcon: { height: themeSpace[3.5], width: themeSpace[3.5] },
  statusIconSuccess: {
    height: themeSpace[3.5],
    width: themeSpace[3.5],
    color: themeColors.statusSuccess,
  },
  /** A build fact, set in the mono face so it reads as a fixed value. */
  value: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.85rem',
    color: themeColors.mutedForeground,
  },
  /** The icon inside a button, with the button's own gap before it. */
  buttonIcon: { marginRight: themeSpace[1], height: themeSpace[3.5], width: themeSpace[3.5] },
  /** A row's trailing mark. */
  trailing: { height: themeSpace[4], width: themeSpace[4] },
});

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
      <span {...stylex.props(styles.status)}>
        <CheckCircle2 {...stylex.props(styles.statusIconSuccess)} />
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
        <Spinner className="h-3.5 w-3.5" />
        {t('settings.about.downloading', { percent: String(p) })}
      </span>
    );
  }

  if (phase === 'disabled') {
    return <span {...stylex.props(styles.statusQuiet)}>{t('settings.about.updaterDisabled')}</span>;
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
  const [inboxBetaEnabled, setInboxBetaEnabled] = useAtom(inboxBetaEnabledAtom);
  const [e2eeCreationEnabled, setE2eeCreationEnabled] = useAtom(e2eeWorkspaceCreationEnabledAtom);
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
              <span {...stylex.props(styles.value)}>{aboutVersion}</span>
            </MobileSettingsRow>
          ) : null}
          <MobileSettingsRow label={t('settings.about.buildDate')}>
            <span {...stylex.props(styles.value)}>{formatBuildDate(BUILD_DATE)}</span>
          </MobileSettingsRow>
          {/* The reveal target is the commit row, not the version row: the
             version row only renders when a version is known (absent on narrow
             web), which would leave the gesture unreachable exactly where the
             desktop panel is also unavailable. */}
          <MobileSettingsRow
            label={t('settings.about.commitHash')}
            onClick={() => setRevealTaps((count) => count + 1)}
          >
            <span {...stylex.props(styles.value)}>{GIT_COMMIT}</span>
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
            trailing={<ExternalLink {...stylex.props(styles.trailing)} />}
          />
          <MobileSettingsRow
            label={t('settings.about.website', 'Website')}
            onClick={handleOpenWebsite}
            trailing={<ExternalLink {...stylex.props(styles.trailing)} />}
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
                size="small"
                onClick={() => {
                  void handleQuitAndInstall();
                }}
                disabled={isInstalling}
              >
                {isInstalling ? (
                  <Spinner className="mr-1 h-3.5 w-3.5" />
                ) : (
                  <Download {...stylex.props(styles.buttonIcon)} />
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
                {isChecking ? <Spinner className="mr-1 h-3.5 w-3.5" /> : null}
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
              label={t('settings.beta.e2eeWorkspace', 'Encrypted workspace creation')}
              helper={t(
                'settings.beta.e2eeWorkspaceHelper',
                'Create a workspace with a device identity and signed permission history. Conversation sync and execution are not available yet. Existing workspaces are unchanged.'
              )}
            >
              <Switch
                checked={e2eeCreationEnabled}
                onCheckedChange={setE2eeCreationEnabled}
                aria-label={t('settings.beta.e2eeWorkspace', 'Encrypted workspace creation')}
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
