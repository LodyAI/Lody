// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  atoms: new Map<string, unknown>(),
  beginArgs: null as Record<string, unknown> | null,
  completeArgs: null as Record<string, unknown> | null,
  completeWait: null as Promise<void> | null,
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
  useLocation: () => ({
    pathname: '/team/settings/github',
    search: {},
    searchStr: window.location.search,
    hash: window.location.hash.slice(1),
  }),
  useNavigate: () => state.navigate,
  Outlet: () => null,
}));
vi.mock('jotai', async (original) => ({
  ...(await original<typeof import('jotai')>()),
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
// The route fixture represents an admitted ordinary workspace; admission behavior
// is exercised by workspace-legacy-queries.test.tsx, not the OAuth handoff assertions.
vi.mock('../src/hooks/use-workspace-feature', () => ({
  useLegacyWorkspaceQueryStatus: () => 'allowed',
  useAssertLegacyWorkspaceAccess: () => () => 'synthetic-ordinary-admission',
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
    await state.completeWait;
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
  state.completeWait = null;
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

it('does not restore a previous installation callback over navigation while OAuth completion is pending', async () => {
  vi.stubEnv('VITE_CONVEX_SITE_URL', 'https://synthetic.convex.site');
  let finish!: () => void;
  state.completeWait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const retry =
    'https://synthetic.convex.site/api/github/callback?installation_id=42&setup_action=update&state=install-state';
  window.history.replaceState(
    null,
    '',
    `/team/settings/github?github_install_error=authorization_required#github-install-retry=${encodeURIComponent(retry)}`
  );
  storePersonalGitHubProof('state', 'verifier');
  window.history.replaceState(
    null,
    '',
    `/team/settings/github#github-personal=${encodeURIComponent(JSON.stringify({ state: 'state', code: 'code' }))}`
  );
  await act(async () => root.render(createElement(SettingsHook)));
  window.history.replaceState(null, '', '/another-team/chat?context=github#new-context');
  await act(async () => finish());
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(
    '/another-team/chat?context=github#new-context'
  );
  vi.unstubAllEnvs();
});

it('restores the same installation retry after OAuth completion for an explicit retry', async () => {
  vi.stubEnv('VITE_CONVEX_SITE_URL', 'https://synthetic.convex.site');
  const retry =
    'https://synthetic.convex.site/api/github/callback?installation_id=42&setup_action=update&state=install-state';
  const recovery = `?github_install_error=authorization_required#github-install-retry=${encodeURIComponent(retry)}`;
  window.history.replaceState(null, '', `/team/settings/github${recovery}`);
  storePersonalGitHubProof('state', 'verifier');
  window.history.replaceState(
    null,
    '',
    `/team/settings/github#github-personal=${encodeURIComponent(JSON.stringify({ state: 'state', code: 'code' }))}`
  );
  await act(async () => root.render(createElement(SettingsHook)));
  expect(window.location.pathname).toBe('/team/settings/github');
  expect(window.location.search + window.location.hash).toBe(recovery);
  expect(state.completeArgs).toEqual({
    workspaceId: 'workspace',
    state: 'state',
    code: 'code',
    verifier: 'verifier',
  });
  vi.unstubAllEnvs();
});
