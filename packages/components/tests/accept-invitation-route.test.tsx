// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    ...(options as object),
    useParams: () => ({ invitationId: 'inv-1' }),
  }),
  useNavigate: () => mocks.navigate,
}));

const stablePreview = {
  status: 'available' as const,
  organizationName: 'Acme',
  inviterName: 'Alex',
  recipientEmailMasked: 'a***@example.test',
  role: 'member',
  recipientMatchesSession: true,
};
const stableSession = {
  data: { user: { id: 'u1', email: 'alex@example.test' } },
  isPending: false,
  isRetrying: false,
  error: null,
  refetch: vi.fn(),
};
const stableAuthClient = {
  organization: {
    getInvitation: mocks.getInvitation,
    acceptInvitation: mocks.acceptInvitation,
  },
};

vi.mock('@lody/platform/react', () => ({
  usePlatformCapability: () => true,
  useCloudQueryState: () => ({
    data: stablePreview,
    error: null,
    retry: vi.fn(),
  }),
}));

vi.mock('@/hooks/useStableSession', () => ({
  useStableSession: () => stableSession,
}));

vi.mock('../src/providers/convex-provider', () => ({
  useAuthClient: () => stableAuthClient,
  useAuthSignOut: () => mocks.signOut,
}));

import { AcceptInvitationComponent } from '../src/routes/invite/$invitationId';

describe('AcceptInvitationComponent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    mocks.navigate.mockReset();
    mocks.getInvitation.mockReset();
    mocks.acceptInvitation.mockReset();
    mocks.signOut.mockReset();
    mocks.getInvitation.mockResolvedValue({
      data: {
        id: 'inv-1',
        organizationId: 'org-1',
        organizationName: 'Acme',
        organizationSlug: 'acme',
        inviterEmail: 'owner@example.test',
        email: 'alex@example.test',
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
      },
      error: null,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const buttonByText = (label: string) =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

  it('transitions to error with Retry when acceptInvitation throws instead of spinning forever', async () => {
    mocks.acceptInvitation
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ data: { id: 'inv-1' }, error: null });

    await act(async () => root.render(<AcceptInvitationComponent />));
    await act(async () => {
      await Promise.resolve();
    });

    const acceptBtn = buttonByText('Accept invitation');
    expect(acceptBtn).toBeDefined();
    await act(async () => acceptBtn!.click());
    await act(async () => {
      await Promise.resolve();
    });

    const retryBtn = buttonByText('Retry');
    expect(retryBtn).toBeDefined();
    await act(async () => retryBtn!.click());
    await act(async () => {
      await Promise.resolve();
    });

    const openBtn = buttonByText('Open workspace');
    expect(openBtn).toBeDefined();
    await act(async () => openBtn!.click());
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/$workspaceName/chat',
      params: { workspaceName: 'acme' },
    });

    // Clicking Open workspace cleared the 1500ms redirect timer.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
});
