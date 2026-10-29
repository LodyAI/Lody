import type { Meta, StoryObj } from '@storybook/react';
import { Provider as JotaiProvider } from 'jotai';
import { useEffect, useState, type CSSProperties } from 'react';
import type { ElectronUpdaterState, QuitAndInstallElectronUpdateResult } from '@lody/shared';
import { MobileAboutSettings } from '@/components/mobile/mobile-about-settings';
import { SettingsStoryProviders } from './settings-story-shell';

type Scenario = 'checking' | 'downloading' | 'installing';
type Controller = { advanceDownload: () => void; failInstall: () => void };

function AboutUpdaterFixture({
  scenario,
  scoped = false,
}: {
  scenario: Scenario;
  scoped?: boolean;
}) {
  const [controller, setController] = useState<Controller | null>(null);
  const [phase, setPhase] = useState('mounting');
  const [receipt, setReceipt] = useState('none');

  useEffect(() => {
    const previousBridge = window.ipc;
    const previousElectron = window.__LODY_ELECTRON__;
    const root = document.documentElement;
    const previousSpacing = root.style.getPropertyValue('--spacing');
    const previousPriority = root.style.getPropertyPriority('--spacing');
    if (scoped) root.style.setProperty('--spacing', '6px');
    const listeners = new Set<(payload: unknown) => void>();
    let state: ElectronUpdaterState = {
      phase:
        scenario === 'checking' ? 'idle' : scenario === 'installing' ? 'downloaded' : 'downloading',
      currentVersion: '1.0.0',
      availableVersion: '1.0.1',
      downloadedVersion: scenario === 'installing' ? '1.0.1' : undefined,
      percent: 37,
    };
    let finishInstall: ((value: QuitAndInstallElectronUpdateResult) => void) | undefined;
    const publish = (next: ElectronUpdaterState) => {
      state = next;
      setPhase(state.phase);
      for (const listener of listeners) listener(state);
    };
    window.__LODY_ELECTRON__ = true;
    window.ipc = {
      invoke: async (channel) => {
        if (channel === 'app.setNativeTheme' || channel === 'app.setStartupThemeSource') {
          return undefined;
        }
        setReceipt(channel);
        if (channel === 'updater.getState') return state;
        if (channel === 'updater.checkForUpdates') {
          publish({ ...state, phase: 'checking' });
          return { started: true };
        }
        if (channel === 'updater.quitAndInstall') {
          return new Promise<QuitAndInstallElectronUpdateResult>((resolve) => {
            finishInstall = resolve;
          });
        }
        throw new Error(`Unsupported story IPC channel: ${channel}`);
      },
      on: (channel, listener) => {
        if (channel === 'app.nativeTheme') return () => {};
        if (channel !== 'updater.state') throw new Error(`Unsupported story event: ${channel}`);
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send: (channel) => {
        throw new Error(`Unsupported story send: ${channel}`);
      },
    };
    setPhase(state.phase);
    setController({
      advanceDownload: () => publish({ ...state, percent: 68 }),
      failInstall: () => {
        setReceipt('updater.quitAndInstall:failed');
        finishInstall?.({ ok: false, error: 'synthetic_install_failure' });
        finishInstall = undefined;
      },
    });
    return () => {
      finishInstall?.({ ok: false, error: 'story_unmounted' });
      listeners.clear();
      window.ipc = previousBridge;
      window.__LODY_ELECTRON__ = previousElectron;
      if (scoped) {
        if (previousSpacing) root.style.setProperty('--spacing', previousSpacing, previousPriority);
        else root.style.removeProperty('--spacing');
      }
    };
  }, [scenario, scoped]);

  return (
    <div
      data-about-updater-fixture
      data-phase={phase}
      data-ipc-receipt={receipt}
      data-scoped={scoped}
      style={
        { maxWidth: 720, padding: 12, ...(scoped ? { '--spacing': '3px' } : {}) } as CSSProperties
      }
    >
      <p>Chromium UI fixture with synthetic Electron public IPC. No update download or restart.</p>
      {controller ? <MobileAboutSettings /> : null}
      {scenario === 'downloading' ? (
        <button type="button" onClick={() => controller?.advanceDownload()}>
          Advance download to 68%
        </button>
      ) : null}
      {scenario === 'installing' ? (
        <button type="button" onClick={() => controller?.failInstall()}>
          Return failed install response
        </button>
      ) : null}
      <output>{receipt}</output>
    </div>
  );
}

const meta = {
  title: 'Migration/MobileAboutUpdaterSpinner',
  component: AboutUpdaterFixture,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <JotaiProvider>
        <SettingsStoryProviders>
          <Story />
        </SettingsStoryProviders>
      </JotaiProvider>
    ),
  ],
} satisfies Meta<typeof AboutUpdaterFixture>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Checking: Story = { args: { scenario: 'checking' } };
export const Downloading: Story = { args: { scenario: 'downloading' } };
export const Installing: Story = { args: { scenario: 'installing' } };
export const ScopedChecking: Story = { args: { scenario: 'checking', scoped: true } };
export const ScopedDownloading: Story = { args: { scenario: 'downloading', scoped: true } };
export const ScopedInstalling: Story = { args: { scenario: 'installing', scoped: true } };
