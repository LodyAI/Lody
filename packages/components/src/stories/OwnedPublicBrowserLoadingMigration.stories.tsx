import { useCallback, useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { ElectronPublicBrowserResult, ElectronPublicBrowserState } from '@lody/shared';
import { PublicBrowserSurface } from '@/components/sessions/public-browser-surface';

const browserId = 'storybook-public-browser-loading';
const request = { id: 1, url: 'https://public-browser.invalid/fixture' };

function Harness({
  localSpacing,
  outcome = 'ready',
}: {
  localSpacing?: boolean;
  outcome?: 'ready' | 'error';
}) {
  const [bridgeReady, setBridgeReady] = useState(false);
  const [state, setState] = useState<ElectronPublicBrowserState | null>(null);
  const [consumed, setConsumed] = useState(false);
  const [finish, setFinish] = useState<((error: boolean) => void) | null>(null);
  const observeState = useCallback((next: ElectronPublicBrowserState) => setState(next), []);
  const consumeRequest = useCallback(() => setConsumed(true), []);

  useEffect(() => {
    const previousElectron = window.__LODY_ELECTRON__;
    const previousIpc = window.ipc;
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    let current: ElectronPublicBrowserState = {
      browserId,
      phase: 'idle',
      canGoBack: false,
      canGoForward: false,
    };
    let completeNavigation: ((value: ElectronPublicBrowserResult) => void) | undefined;
    const finishNavigation = (error: boolean) => {
      const errorMessage = 'Synthetic public-browser navigation failure.';
      current = {
        ...current,
        phase: error ? 'error' : 'ready',
        url: request.url,
        ...(error ? { error: errorMessage } : {}),
      };
      for (const listener of listeners.get('publicBrowser.state') ?? []) listener(current);
      completeNavigation?.(
        error ? { ok: false, error: errorMessage } : { ok: true, state: current }
      );
      setFinish(null);
    };
    // Only the IPC data boundary is synthetic. No native view or network is created.
    window.__LODY_ELECTRON__ = true;
    window.ipc = {
      invoke: async (channel) => {
        switch (channel) {
          case 'app.setNativeTheme':
          case 'app.setStartupThemeSource':
            return undefined;
          case 'publicBrowser.create':
          case 'publicBrowser.setBounds':
          case 'publicBrowser.setVisible':
            return { ok: true, state: current } satisfies ElectronPublicBrowserResult;
          case 'publicBrowser.navigate':
            current = { ...current, phase: 'loading', url: request.url };
            for (const listener of listeners.get('publicBrowser.state') ?? []) listener(current);
            setFinish(() => finishNavigation);
            return new Promise<ElectronPublicBrowserResult>((resolve) => {
              completeNavigation = resolve;
            });
          default:
            throw new Error(`Unexpected synthetic public-browser IPC: ${channel}`);
        }
      },
      on: (channel, listener) => {
        const set = listeners.get(channel) ?? new Set<(payload: unknown) => void>();
        set.add(listener);
        listeners.set(channel, set);
        return () => set.delete(listener);
      },
      send: (channel) => {
        throw new Error(`Unexpected synthetic public-browser send: ${channel}`);
      },
    };
    setBridgeReady(true);
    return () => {
      listeners.clear();
      completeNavigation?.({ ok: false, error: 'Synthetic story unmounted.' });
      window.__LODY_ELECTRON__ = previousElectron;
      window.ipc = previousIpc;
    };
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        ...(localSpacing ? { '--spacing': '5px' } : {}),
      }}
    >
      <div>
        <button type="button" disabled={!finish} onClick={() => finish?.(outcome === 'error')}>
          Complete synthetic navigation
        </button>
        <output data-testid="public-browser-fixture-state">
          {state?.phase ?? 'installing'}; consumed={String(consumed)}; pending={String(!!finish)}
        </output>
      </div>
      {bridgeReady ? (
        <PublicBrowserSurface
          browserId={browserId}
          navigationRequest={consumed ? null : request}
          active
          onStateChange={observeState}
          onNavigationRequestConsumed={consumeRequest}
        />
      ) : null}
    </div>
  );
}

const meta = {
  title: 'Sessions/OwnedPublicBrowserLoadingMigration',
  component: Harness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Failure: Story = { args: { outcome: 'error' } };
export const SubtreeSpacing: Story = { args: { localSpacing: true } };
export const SubtreeSpacingError: Story = { args: { localSpacing: true, outcome: 'error' } };
