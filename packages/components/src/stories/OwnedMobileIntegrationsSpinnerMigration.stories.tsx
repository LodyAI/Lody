import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Provider, createStore } from 'jotai';
import type { CloudApi } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { WorkspaceId } from '@lody/shared';
import { MobileIntegrationsSettings } from '../components/mobile/mobile-integrations-settings';
import { SettingsDataCacheProvider } from '../components/settings/settings-data-cache';
import { AuthenticatedConvexContext } from '../hooks/use-authenticated-convex';
import { setWorkspaceContextAtom } from '../atoms/workspace-context';
import { TEST_CLOUD_PLATFORM } from '../../tests/test-platform';
import { SettingsStoryProviders } from './settings-story-shell';

const workspaceId = 'settings-story-workspace' as WorkspaceId;
const emptyRows: never[] = [];
const disabledIdentity = { enabled: false, authorization: { state: 'missing' as const } };
const enabledIdentity = { enabled: true, authorization: { state: 'missing' as const } };
type Mode = 'auth-recovery' | 'repos-loading' | 'preference';

function Fixture({ mode, spacing = false }: { mode: Mode; spacing?: boolean }) {
  const [resolved, setResolved] = useState(false);
  const [pending, setPending] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const desiredRef = useRef(false);
  const resolveRef = useRef<(() => void) | null>(null);
  const [store] = useState(() => {
    const next = createStore();
    next.set(setWorkspaceContextAtom, { workspaceId, slug: 'lody' });
    return next;
  });
  useLayoutEffect(() => {
    if (!spacing) return;
    const root = document.documentElement;
    const old = root.style.getPropertyValue('--spacing');
    root.style.setProperty('--spacing', '5px');
    return () => {
      if (old) root.style.setProperty('--spacing', old);
      else root.style.removeProperty('--spacing');
    };
  }, [spacing]);
  const cloudApi = useMemo<CloudApi>(
    () => ({
      useQuery: (operation, args) => {
        if (args === 'skip') return undefined;
        switch (operation.name) {
          case 'github:getPersonalOperationSettings':
            return (enabled ? enabledIdentity : disabledIdentity) as never;
          case 'github:listWorkspaceReposWithStatus':
            return (mode === 'repos-loading' && !resolved ? undefined : emptyRows) as never;
          case 'github:getWorkspaceRepositories':
            return emptyRows as never;
          case 'usage:getWorkspaceUsageTimeline':
          case 'usage:getWorkspaceUsageCalendar':
            return undefined;
          default:
            throw new Error(`Unexpected synthetic integration query: ${operation.name}`);
        }
      },
      useMutation: (operation) => async (args) => {
        if (operation.name !== 'github:setPersonalOperationPreference')
          throw new Error(`Unexpected synthetic integration mutation: ${operation.name}`);
        desiredRef.current = (args as { enabled: boolean }).enabled;
        setPending(true);
        await new Promise<void>((resolve) => {
          resolveRef.current = resolve;
        });
        return undefined as never;
      },
      useAction: (operation) => async () => {
        throw new Error(`Unexpected synthetic integration action: ${operation.name}`);
      },
    }),
    [enabled, mode, resolved]
  );
  const recovering = mode === 'auth-recovery' && !resolved;
  return (
    <Provider store={store}>
      <SettingsStoryProviders>
        <PlatformContext.Provider value={{ ...TEST_CLOUD_PLATFORM, cloudApi }}>
          <AuthenticatedConvexContext.Provider
            value={{
              authSessionId: 'synthetic-integrations-spinner',
              isAuthenticated: !recovering,
              isLoading: recovering,
              isRecovering: recovering,
              confirmedUnauthenticated: false,
              claimAutomaticCommand: () => false,
              requestAuthRecovery: () => {},
            }}
          >
            <main
              data-owned-integrations-spinner={mode}
              data-resolved={resolved}
              data-pending={pending}
              data-spacing={spacing}
              style={{
                minHeight: '100dvh',
                maxWidth: 640,
                marginInline: 'auto',
                paddingBlock: 12,
                background: 'hsl(var(--background))',
                color: 'hsl(var(--foreground))',
              }}
            >
              <div style={{ display: 'flex', gap: 12, padding: 12 }}>
                <button
                  type="button"
                  disabled={resolved || mode === 'preference'}
                  onClick={() => setResolved(true)}
                >
                  Resolve synthetic integration state
                </button>
                <button
                  type="button"
                  disabled={!pending}
                  onClick={() => {
                    setEnabled(desiredRef.current);
                    setPending(false);
                    resolveRef.current?.();
                    resolveRef.current = null;
                  }}
                >
                  Complete synthetic preference
                </button>
              </div>
              <section data-owned-integrations-target="">
                <SettingsDataCacheProvider>
                  <MobileIntegrationsSettings />
                </SettingsDataCacheProvider>
              </section>
            </main>
          </AuthenticatedConvexContext.Provider>
        </PlatformContext.Provider>
      </SettingsStoryProviders>
    </Provider>
  );
}
const meta = {
  title: 'Migration/OwnedMobileIntegrationsSpinner',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const AuthRecovery: Story = { render: () => <Fixture mode="auth-recovery" /> };
export const AuthRecoveryRootSpacing: Story = {
  render: () => <Fixture mode="auth-recovery" spacing />,
};
export const ReposLoading: Story = { render: () => <Fixture mode="repos-loading" /> };
export const ReposLoadingRootSpacing: Story = {
  render: () => <Fixture mode="repos-loading" spacing />,
};
export const Preference: Story = { render: () => <Fixture mode="preference" /> };
export const PreferenceRootSpacing: Story = { render: () => <Fixture mode="preference" spacing /> };
