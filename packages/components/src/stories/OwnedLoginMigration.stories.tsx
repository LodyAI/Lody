import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useState, type ComponentProps, type CSSProperties } from 'react';
import { Provider, createStore } from 'jotai';
import { LoginPage } from '../components/login-page';
import { AuthProvider } from '../providers/convex-provider';
import { StableSessionContext } from '../hooks/useStableSession';
import type { LodyAuthClient } from '../lib/auth';

const meta = {
  title: 'Components/OwnedLoginMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type SessionValue = NonNullable<ComponentProps<typeof StableSessionContext.Provider>['value']>;

function Fixture({
  mode,
  scoped = false,
}: {
  mode: 'providers' | 'email' | 'handoff';
  scoped?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState('Ready');
  const [store] = useState(createStore);
  useLayoutEffect(() => {
    const previousUrl = window.location.href;
    const previousMethod = window.localStorage.getItem('lody.auth.last_login_method');
    const url = new URL(previousUrl);
    url.search =
      mode === 'handoff'
        ? '?client_id=electron&state=synthetic-state&code_challenge=synthetic-challenge'
        : mode === 'email'
          ? '?view=email'
          : '';
    window.history.replaceState({}, '', url);
    window.localStorage.removeItem('lody.auth.last_login_method');
    setReady(true);
    return () => {
      window.history.replaceState({}, '', previousUrl);
      if (previousMethod === null) window.localStorage.removeItem('lody.auth.last_login_method');
      else window.localStorage.setItem('lody.auth.last_login_method', previousMethod);
    };
  }, [mode]);
  if (!ready) return null;

  const data =
    mode === 'handoff'
      ? ({
          user: { id: 'synthetic-user', name: 'Synthetic user', email: 'fixture@example.com' },
          session: { token: 'synthetic-fixture-token' },
        } as SessionValue['data'])
      : null;
  const session: SessionValue = {
    data,
    rawData: data,
    bootstrapSnapshot: null,
    hasLocalToken: Boolean(data),
    hasRawUser: Boolean(data),
    isOptimistic: false,
    isPending: false,
    isRetrying: false,
    error: null,
    confirmedUnauthenticated: !data,
    refetch: async () => undefined,
  };
  const pending = (intent: string) => {
    setResult(intent);
    return new Promise<never>(() => {});
  };
  const authClient = {
    signIn: {
      social: () => pending('Synthetic provider requested'),
      email: () => pending('Synthetic email requested'),
    },
    signUp: { email: () => pending('Synthetic sign-up requested') },
    sendVerificationEmail: () => pending('Synthetic verification requested'),
    signOut: async () => undefined,
    getSession: async () => ({ data: null }),
    electron: { transferUser: () => pending('Synthetic handoff requested') },
  } as unknown as LodyAuthClient;
  const variables = scoped
    ? ({ '--spacing': '0.3125rem', '--radius-md': '13px' } as CSSProperties)
    : undefined;
  return (
    <Provider store={store}>
      <AuthProvider authClient={authClient}>
        <StableSessionContext.Provider value={session}>
          <div data-owned-login-ready="" style={variables}>
            <LoginPage
              isElectronRenderer={false}
              replaceLocation={() => setResult('Synthetic navigation requested')}
            />
            <output data-owned-login-intent="" style={{ position: 'fixed', bottom: 0, left: 0 }}>
              {result}
            </output>
          </div>
        </StableSessionContext.Provider>
      </AuthProvider>
    </Provider>
  );
}

export const ScopedProviders: Story = { render: () => <Fixture mode="providers" scoped /> };
export const EmailPending: Story = { render: () => <Fixture mode="email" /> };
export const ScopedEmailPending: Story = { render: () => <Fixture mode="email" scoped /> };
export const HandoffPending: Story = { render: () => <Fixture mode="handoff" /> };
