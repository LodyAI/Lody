// @vitest-environment jsdom

import { act } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  query: vi.fn(),
  submit: vi.fn(),
  session: null as null | {
    user: { email: string };
  },
  authClient: { id: 'auth-client' },
  signOutWithoutRedirect: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => {
    return {
      ...options,
      options,
      useParams: () => ({ token: 'open-token' }),
    };
  },
  useNavigate: () => mocks.navigate,
}));

vi.mock('@lody/platform/react', () => ({
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

import { Route } from '../src/routes/join/$token';

const WorkspaceJoinRequestRoute = Route.options.component as ComponentType;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkspaceJoinRequestRoute', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.session = null;
  });

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
