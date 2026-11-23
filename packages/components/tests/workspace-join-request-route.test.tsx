// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  token: 'open-token',
  navigate: vi.fn(),
  query: vi.fn(),
  submit: vi.fn(),
  session: null as null | {
    user: { email: string };
  },
  authClient: { id: 'auth-client' },
  signOutWithoutRedirect: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ token: mocks.token }),
  }),
  useNavigate: () => mocks.navigate,
}));

vi.mock('@lody/platform/react', () => ({
  usePlatform: () => ({ e2eeWorkspaces: undefined }),
  useCloudMutation: () => mocks.submit,
  useCloudQuery: (...args: unknown[]) => mocks.query(...args),
  usePlatformCapability: () => true,
}));

vi.mock('../src/hooks/useStableSession', () => ({
  useStableSession: () => ({ data: mocks.session, isPending: false }),
}));

vi.mock('../src/providers/convex-provider', () => ({
  useAuthClient: () => mocks.authClient,
}));

vi.mock('../src/lib/auth', () => ({
  signOutWithoutRedirect: (...args: unknown[]) => mocks.signOutWithoutRedirect(...args),
}));

import { WorkspaceJoinRequestRoute } from '../src/routes/join/$token';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkspaceJoinRequestRoute', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.session = null;
    mocks.token = 'open-token';
    window.location.hash = '';
  });

  it.each(['ordinary', 'encrypted'])(
    'opens the second encrypted invitation after an %s invitation without a page reload',
    async (first) => {
      await initI18n('en');
      const offer = {
        version: 1,
        workspaceId: 'team-a',
        genesisHash: '11'.repeat(32),
        genesisRecordHex: 'abcd',
        endorser: '22'.repeat(32),
        token: '33'.repeat(32),
        mode: 'link',
        expiresAt: 9000000000000,
      };
      const next = { ...offer, workspaceId: 'team-b', token: '44'.repeat(32) };
      const props = (value: typeof offer) => ({
        status: 'available',
        offer: value,
        workspaceName: value.workspaceId,
        workspaceSlug: value.workspaceId,
        recipientEmailMasked: null,
        matchesRecipient: null,
      });
      mocks.query.mockImplementation((_operation, args) =>
        args.token === offer.token
          ? props(offer)
          : args.token === next.token
            ? props(next)
            : {
                status: 'available',
                workspaceName: 'ordinary',
                workspaceSlug: 'ordinary',
                expiresAt: 9000000000000,
                viewer: null,
              }
      );
      mocks.token = first === 'ordinary' ? 'open-token' : offer.token;
      window.location.hash =
        first === 'ordinary' ? '' : 'e2ee=' + encodeURIComponent(JSON.stringify(offer));
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(<WorkspaceJoinRequestRoute />));
        mocks.token = next.token;
        window.location.hash = 'e2ee=' + encodeURIComponent(JSON.stringify(next));
        await act(async () => root.render(<WorkspaceJoinRequestRoute />));
        expect(container.textContent).toContain('team-b');
        expect(container.textContent).not.toContain('team-a');
        const signIn = [...container.querySelectorAll('button')].find(
          (button) => button.textContent === 'Sign in or register'
        )!;
        await act(async () => signIn.click());
        expect(mocks.navigate.mock.calls.at(-1)?.[0].search.redirect).toBe(
          `/join/${next.token}#e2ee=${encodeURIComponent(JSON.stringify(next))}`
        );
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  );

  it('loads the public preview before authentication and preserves the join URL on sign-in', async () => {
    await initI18n('en');
    mocks.query.mockReturnValue({
      status: 'available',
      workspaceName: 'PKU Research Lab',
      workspaceSlug: 'pku',
      expiresAt: 9_000_000_000_000_000,
      viewer: null,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<WorkspaceJoinRequestRoute />);
    });
    expect(mocks.query).toHaveBeenCalledOnce();

    const continueButton = container.querySelector('button');
    expect(continueButton).not.toBeNull();
    await act(async () => continueButton?.click());
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/login',
      search: { redirect: '/join/open-token', view: 'email' },
    });

    await act(async () => root.unmount());
    container.remove();
  });

  it('signs out without redirect before the host preserves the join URL for verification', async () => {
    await initI18n('en');
    mocks.session = { user: { email: 'member@example.com' } };
    mocks.query.mockReturnValue({
      status: 'available',
      workspaceName: 'PKU Research Lab',
      workspaceSlug: 'pku',
      expiresAt: 9_000_000_000_000_000,
      viewer: {
        emailVerified: false,
        alreadyMember: false,
        request: null,
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<WorkspaceJoinRequestRoute />);
    });

    const verifyButton = container.querySelector('button');
    expect(verifyButton).not.toBeNull();
    await act(async () => verifyButton?.click());

    expect(mocks.signOutWithoutRedirect).toHaveBeenCalledWith(mocks.authClient);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/login',
      search: { redirect: '/join/open-token', view: 'email' },
    });
    expect(mocks.signOutWithoutRedirect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0]
    );

    await act(async () => root.unmount());
    container.remove();
  });
});
