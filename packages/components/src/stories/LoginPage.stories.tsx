import type { Meta, StoryObj } from '@storybook/react';
import type { ComponentProps } from 'react';
import { useLayoutEffect, useState } from 'react';
import { within, userEvent, fn } from 'storybook/test';
import { LoginPage, type LoginPageProps } from '@/components/login-page';
import { AuthProvider } from '@/providers/convex-provider';
import { StableSessionContext } from '@/hooks/useStableSession';
import type { LodyAuthClient } from '@/lib/auth';

type StableSessionValue = NonNullable<
  ComponentProps<typeof StableSessionContext.Provider>['value']
>;

type LoginPageStoryHarnessProps = LoginPageProps & {
  sessionValue: StableSessionValue;
  signInSocial?: () => Promise<void>;
  signInEmail?: () => Promise<unknown>;
  signUpEmail?: () => Promise<unknown>;
  sendVerificationEmail?: () => Promise<unknown>;
  transferUser?: () => Promise<{ data?: { electron_authorization_code?: string | null } }>;
};

function createStableSessionValue(overrides: Partial<StableSessionValue> = {}): StableSessionValue {
  const baseData = overrides.data ?? null;
  return {
    data: baseData,
    rawData: overrides.rawData ?? baseData,
    bootstrapSnapshot: overrides.bootstrapSnapshot ?? null,
    hasLocalToken: overrides.hasLocalToken ?? false,
    hasRawUser: overrides.hasRawUser ?? false,
    isOptimistic: overrides.isOptimistic ?? false,
    isPending: overrides.isPending ?? false,
    isRetrying: overrides.isRetrying ?? false,
    error: overrides.error ?? null,
    confirmedUnauthenticated: overrides.confirmedUnauthenticated ?? false,
    refetch: overrides.refetch ?? (async () => undefined),
  };
}

function LoginPageStoryHarness({
  sessionValue,
  signInSocial,
  signInEmail,
  signUpEmail,
  sendVerificationEmail,
  transferUser,
  replaceLocation,
  isElectronRenderer,
}: LoginPageStoryHarnessProps) {
  const authClient = {
    signIn: {
      social: signInSocial ?? (async () => undefined),
      email: signInEmail ?? (async () => ({ data: null, error: null })),
    },
    signUp: {
      email: signUpEmail ?? (async () => ({ data: null, error: null })),
    },
    sendVerificationEmail: sendVerificationEmail ?? (async () => ({ data: null, error: null })),
    signOut: async () => undefined,
    electron: transferUser ? { transferUser } : undefined,
  } as unknown as LodyAuthClient;

  return (
    <AuthProvider authClient={authClient}>
      <StableSessionContext.Provider value={sessionValue}>
        <div className="min-h-screen bg-background">
          <LoginPage replaceLocation={replaceLocation} isElectronRenderer={isElectronRenderer} />
        </div>
      </StableSessionContext.Provider>
    </AuthProvider>
  );
}

function WithSearchParam({ search, children }: { search: string; children: React.ReactNode }) {
  // Apply the search param synchronously on mount so that any child
  // useState initializer that reads window.location.search sees it.
  // Without this, children render once with the wrong URL before the
  // useEffect fires.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const currentUrl = new URL(window.location.href);
    const previousSearch = currentUrl.search;
    currentUrl.search = search;
    window.history.replaceState({}, '', currentUrl);
    setReady(true);

    return () => {
      const resetUrl = new URL(window.location.href);
      resetUrl.search = previousSearch;
      window.history.replaceState({}, '', resetUrl);
    };
  }, [search]);

  if (!ready) return null;
  return <>{children}</>;
}

const meta = {
  title: 'Components/LoginPage',
  component: LoginPage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    replaceLocation: fn(),
  },
} satisfies Meta<typeof LoginPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const authenticatedSession = createStableSessionValue({
  data: {
    user: {
      id: 'user-storybook',
      email: 'storybook@lody.ai',
      name: 'Storybook User',
    },
    session: {
      token: 'storybook-token',
    },
  } as StableSessionValue['data'],
  hasRawUser: true,
});

export const Default: Story = {
  render: (args) => <LoginPageStoryHarness {...args} sessionValue={createStableSessionValue()} />,
};

export const SessionPending: Story = {
  render: (args) => (
    <LoginPageStoryHarness
      {...args}
      sessionValue={createStableSessionValue({
        hasLocalToken: true,
        isPending: true,
      })}
    />
  ),
};

export const LoadingAuthenticating: Story = {
  render: (args) => (
    <LoginPageStoryHarness
      {...args}
      sessionValue={createStableSessionValue({
        isPending: true,
      })}
      signInSocial={() => new Promise<void>(() => {})}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /github/i }));
  },
};

export const EmailView: Story = {
  name: 'Email View',
  render: (args) => <LoginPageStoryHarness {...args} sessionValue={createStableSessionValue()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /continue with email/i }));
  },
};

export const EmailCreateAccountView: Story = {
  name: 'Email Create Account View',
  render: (args) => <LoginPageStoryHarness {...args} sessionValue={createStableSessionValue()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /continue with email/i }));
    await userEvent.click(await canvas.findByRole('button', { name: /create account/i }));
  },
};

export const EmailVerificationSent: Story = {
  render: (args) => <LoginPageStoryHarness {...args} sessionValue={createStableSessionValue()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /continue with email/i }));
    await userEvent.click(await canvas.findByRole('button', { name: /create account/i }));
    await userEvent.type(await canvas.findByLabelText(/name/i), 'Storybook User');
    await userEvent.type(canvas.getByLabelText(/email/i), 'storybook@example.com');
    await userEvent.type(canvas.getByLabelText(/^password$/i), 'password123');
    await userEvent.click(canvas.getByRole('button', { name: /^create account$/i }));
  },
};

export const EmailUnverified: Story = {
  render: (args) => (
    <LoginPageStoryHarness
      {...args}
      sessionValue={createStableSessionValue()}
      signInEmail={async () => ({
        data: null,
        error: {
          status: 403,
          message: 'Email is not verified',
        },
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /continue with email/i }));
    await userEvent.type(await canvas.findByLabelText(/email/i), 'storybook@example.com');
    await userEvent.type(canvas.getByLabelText(/^password$/i), 'password123');
    await userEvent.click(canvas.getByRole('button', { name: /sign in with email/i }));
  },
};

export const ProviderAlignment: Story = {
  name: 'Provider Alignment',
  render: (args) => <LoginPageStoryHarness {...args} sessionValue={createStableSessionValue()} />,
};

export const ElectronRenderer: Story = {
  name: 'Electron Renderer',
  render: (args) => (
    <LoginPageStoryHarness {...args} isElectronRenderer sessionValue={createStableSessionValue()} />
  ),
};

export const ExpiredSession: Story = {
  render: (args) => (
    <WithSearchParam search="?expired=1">
      <LoginPageStoryHarness {...args} sessionValue={createStableSessionValue()} />
    </WithSearchParam>
  ),
};

export const EmailViewFromUrl: Story = {
  name: 'Email View From URL (post-verification)',
  render: (args) => (
    <WithSearchParam search="?view=email&email=jane%40example.com">
      <LoginPageStoryHarness {...args} sessionValue={createStableSessionValue()} />
    </WithSearchParam>
  ),
};

export const VerificationErrorExpired: Story = {
  name: 'Verification Error (Token Expired)',
  render: (args) => (
    <WithSearchParam search="?view=email&email=jane%40example.com&error=TOKEN_EXPIRED">
      <LoginPageStoryHarness {...args} sessionValue={createStableSessionValue()} />
    </WithSearchParam>
  ),
};

export const VerificationErrorNestedInRedirect: Story = {
  name: 'Verification Error (Legacy URL with nested redirect)',
  render: (args) => (
    <WithSearchParam search="?redirect=%2F%3Ferror%3DTOKEN_EXPIRED">
      <LoginPageStoryHarness {...args} sessionValue={createStableSessionValue()} />
    </WithSearchParam>
  ),
};

export const AuthenticatedRedirect: Story = {
  render: (args) => <LoginPageStoryHarness {...args} sessionValue={authenticatedSession} />,
};

// The browser page the desktop app opens, while this browser is still signed in
// (the state a user lands in after signing out of the desktop app). No play
// function clicks Continue: a successful transfer navigates to `lody://…`, and a
// story must not fire a protocol handoff at whoever is browsing the docs. The
// post-transfer state is covered by `tests/electron-browser-login-handoff.test.tsx`.
export const ElectronBrowserHandoff: Story = {
  name: 'Electron Browser Handoff (account choice)',
  render: (args) => (
    <WithSearchParam search="?client_id=electron&state=story-state&code_challenge=story-challenge">
      <LoginPageStoryHarness
        {...args}
        sessionValue={authenticatedSession}
        // Never settles: Continue shows the preparing state without minting a
        // code, so no story can navigate a reader to `lody://`.
        transferUser={() => new Promise(() => {})}
      />
    </WithSearchParam>
  ),
};
