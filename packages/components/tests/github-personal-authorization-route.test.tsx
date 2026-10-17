// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  atoms: new Map<string, unknown>(),
  beginArgs: null as Record<string, unknown> | null,
  completeArgs: null as Record<string, unknown> | null,
  navigate: (options: { hash?: string }) => {
    window.history.replaceState(null, '', `/team/chat${options.hash ? `#${options.hash}` : ''}`);
    return Promise.resolve();
  },
}));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    ...options,
    useParams: () => ({ workspaceName: 'team' }),
  }),
  useLocation: () => ({ pathname: '/team/settings/github', search: {} }),
  useNavigate: () => state.navigate,
  Outlet: () => null,
}));
vi.mock('jotai', () => ({
  useSetAtom: (key: string) => (value: unknown) => {
    state.atoms.set(key, value);
  },
}));
vi.mock('../src/atoms', () => ({
  settingsActiveTabAtom: 'tab',
  settingsDialogOpenAtom: 'open',
  settingsSelectedMachineIdAtom: 'machine',
  settingsSelectedProjectKeyAtom: 'project',
}));
vi.mock('../src/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: () => false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../src/components/app-theme-shell', () => ({ AppThemeShell: () => null }));
vi.mock('../src/components/settings/settings-data-cache', () => ({
  SettingsDataCacheProvider: () => null,
}));
vi.mock('../src/components/mobile/mobile-settings-layout', () => ({
  MobileSettingsLayout: () => null,
}));
vi.mock('../src/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@lody/platform/react', () => ({
  useCloudAction: (operation: { name: string }) => async (args: Record<string, unknown>) => {
    if (operation.name.endsWith(':begin')) {
      state.beginArgs = args;
      // Stop at the network boundary, before JSDOM's unsupported external navigation.
      throw new Error('network boundary');
    }
    state.completeArgs = args;
    return { success: true };
  },
}));
import { SettingsLayoutComponent } from '../src/routes/$workspaceName/_auth/settings';
import { usePersonalGitHubAuthorization } from '../src/hooks/use-personal-github-authorization';
import { storePersonalGitHubProof } from '../src/components/settings/github-personal-authorization';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let authorize: () => Promise<void>;
function SettingsHook() {
  authorize = usePersonalGitHubAuthorization('workspace', 'team');
  return null;
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
  state.atoms.clear();
  state.beginArgs = null;
  state.completeArgs = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
it('starts from a chat overlay with a canonical GitHub callback destination', async () => {
  window.history.replaceState(null, '', '/team/chat');
  await act(async () => root.render(createElement(SettingsHook)));
  await expect(authorize()).rejects.toThrow('network boundary');
  expect(state.beginArgs).toMatchObject({
    workspaceId: 'workspace',
    callbackURL: `${window.location.origin}/team/settings/github`,
    challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });
});
it('carries the OAuth return through the desktop settings route into the modal hook', async () => {
  storePersonalGitHubProof('state', 'verifier');
  window.history.replaceState(
    null,
    '',
    `/team/settings/github#github-personal=${encodeURIComponent(JSON.stringify({ state: 'state', code: 'code' }))}`
  );
  await act(async () => root.render(createElement(SettingsLayoutComponent)));
  expect(state.atoms.get('open')).toBe(true);
  expect(state.atoms.get('tab')).toBe('github');
  expect(window.location.pathname).toBe('/team/chat');
  expect(window.location.hash).toContain('github-personal=');
  await act(async () => root.render(createElement(SettingsHook)));
  expect(state.completeArgs).toEqual({
    workspaceId: 'workspace',
    state: 'state',
    code: 'code',
    verifier: 'verifier',
  });
  expect(window.location.hash).toBe('');
  expect(sessionStorage.length).toBe(0);
});
