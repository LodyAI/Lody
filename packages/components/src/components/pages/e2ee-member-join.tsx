import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { useCloudQuery, usePlatform } from '@lody/platform/react';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import type { E2eeMemberOffer, E2eeMemberReplies } from '@lody/cloud-api';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { space } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { useStableSession } from '@/hooks/useStableSession';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { desktopMemberJoinLink, sameMemberOffer } from '@/lib/e2ee-member-offer';
import { attemptDesktopInviteHandoff } from '@/lib/desktop-invite-deep-link';

const styles = stylex.create({
  page: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    padding: space[4],
    backgroundColor: colors.background,
  },
  card: { width: '100%', maxWidth: 460 },
  stack: { display: 'flex', flexDirection: 'column', gap: space[3] },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
});
type Runtime = Pick<
  E2eeWorkspaceRuntime,
  'prepareMemberJoin' | 'pendingMemberJoin' | 'claimMemberJoin'
>;
type Props = {
  offer: E2eeMemberOffer;
  runtime?: Runtime;
  accountId: string | null;
  email?: string;
  emailVerified?: boolean;
  loading?: boolean;
  preview?: E2eeMemberReplies['preview'];
  onSignInRequested: () => void;
  onEmailVerificationRequested: () => void;
  onWorkspaceRequested: (workspaceSlug: string | null, workspaceId?: string) => void;
  onHomeRequested: () => void;
};
export function E2eeMemberJoinSurface(
  props: Pick<
    Props,
    | 'offer'
    | 'onSignInRequested'
    | 'onEmailVerificationRequested'
    | 'onWorkspaceRequested'
    | 'onHomeRequested'
  >
) {
  const platform = usePlatform();
  const session = useStableSession();
  const preview = useCloudQuery(cloudOperations.e2eeMembers.preview, { token: props.offer.token });
  return (
    <E2eeMemberJoin
      {...props}
      runtime={platform.e2eeWorkspaces?.runtime}
      accountId={session.data?.user.id ?? null}
      email={session.data?.user.email}
      emailVerified={session.data?.user.emailVerified}
      loading={session.isPending}
      preview={preview}
    />
  );
}
export function E2eeMemberJoin(props: Props) {
  return <JoinSession key={`${props.accountId}:${props.offer.token}`} {...props} />;
}
function JoinSession({
  offer,
  runtime,
  accountId,
  email,
  emailVerified,
  preview,
  loading,
  onSignInRequested,
  onEmailVerificationRequested,
  onWorkspaceRequested,
  onHomeRequested,
}: Props) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<{ requestId: string; state: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(Boolean(accountId && runtime?.pendingMemberJoin));
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const live = useRef(true);
  const owner = useRef(runtime);
  owner.current = runtime;
  const working = useRef(false);
  const current = () => live.current && owner.current === runtime;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    if (!accountId || !runtime?.pendingMemberJoin) {
      setRecovering(false);
      return undefined;
    }
    setRecovering(true);
    void runtime
      .pendingMemberJoin(offer.workspaceId)
      .then((pending) => {
        if (!disposed && pending?.requestId && sameMemberOffer(pending.offer, offer))
          setRequest({ requestId: pending.requestId, state: 'pending' });
      })
      .catch(() => {
        if (!disposed) setError(true);
      })
      .finally(() => {
        if (!disposed) setRecovering(false);
      });
    return () => {
      disposed = true;
    };
  }, [runtime, accountId, offer]);
  const requestId = request?.requestId;
  const requestTerminal = request ? ['rejected', 'cancelled'].includes(request.state) : false;
  useEffect(() => {
    if (!requestId || !runtime?.claimMemberJoin || ready || requestTerminal) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const claim = async () => {
      try {
        const result = await runtime.claimMemberJoin!(offer.workspaceId, requestId);
        if (disposed) return;
        setRequest((previous) =>
          previous?.requestId === requestId ? { ...previous, state: result.state } : previous
        );
        setReady(result.ready);
        setError(false);
        if (result.ready || ['rejected', 'cancelled'].includes(result.state)) return;
      } catch {
        if (!disposed) setError(true);
      }
      if (!disposed) timer = setTimeout(() => void claim(), 10_000);
    };
    const reconnect = () => {
      clearTimeout(timer);
      setRetry((value) => value + 1);
    };
    window.addEventListener('online', reconnect);
    void claim();
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('online', reconnect);
    };
  }, [runtime, offer.workspaceId, requestId, requestTerminal, ready, retry]);
  const accept = async () => {
    if (working.current || !runtime?.prepareMemberJoin) return;
    working.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await runtime.prepareMemberJoin(offer);
      if (current()) setRequest({ requestId: result.requestId, state: result.state });
    } catch {
      if (current()) setError(true);
      try {
        const pending = await runtime.pendingMemberJoin?.(offer.workspaceId);
        if (current() && pending?.requestId && sameMemberOffer(pending.offer, offer))
          setRequest({ requestId: pending.requestId, state: 'pending' });
      } catch {
        /* Keep saved originals and the first failure. */
      }
    } finally {
      working.current = false;
      if (current()) setBusy(false);
    }
  };
  const available = preview?.status === 'available' ? preview : null;
  const pinMatches = Boolean(available && sameMemberOffer(available.offer, offer));
  const native = Boolean(
    runtime?.prepareMemberJoin && runtime.pendingMemberJoin && runtime.claimMemberJoin
  );
  const terminal = request && ['rejected', 'cancelled'].includes(request.state);
  let message = 'e2ee.team.joinHelp';
  if (loading || recovering || preview === undefined) message = 'e2ee.team.loading';
  else if (!accountId) message = 'e2ee.team.signInHelp';
  else if (!emailVerified) message = 'e2ee.team.verifyHelp';
  else if (!native) message = runtime ? 'e2ee.team.joinUpgrade' : 'e2ee.team.desktopRequired';
  else if (ready) message = 'e2ee.team.ready';
  else if (terminal) message = 'e2ee.team.rejected';
  else if (request?.state === 'committed') message = 'e2ee.team.waitingKey';
  else if (request)
    message = offer.mode === 'email' ? 'e2ee.team.waitingAdminDevice' : 'e2ee.team.waitingApproval';
  else if (!pinMatches) message = 'e2ee.team.unavailable';
  else if (available?.matchesRecipient === false) message = 'e2ee.team.wrongEmail';
  return (
    <main {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.card)}>
        <Card.Root>
          <Card.Header>
            <Card.Title as="h1">
              {available?.workspaceName
                ? t('e2ee.team.joinTitle', { workspace: available.workspaceName })
                : t('e2ee.team.join')}
            </Card.Title>
            <Card.Description>{t(message)}</Card.Description>
          </Card.Header>
          <div {...stylex.props(styles.stack)}>
            {email && <p>{email}</p>}
            {error && <p role="status">{t('e2ee.team.retryOriginal')}</p>}
            <div {...stylex.props(styles.actions)}>
              {!accountId && !loading && (
                <Button onClick={onSignInRequested}>{t('e2ee.team.signIn')}</Button>
              )}
              {accountId && !emailVerified && (
                <Button onClick={onEmailVerificationRequested}>{t('e2ee.team.verify')}</Button>
              )}
              {accountId && emailVerified && !native && !runtime && (
                <Button onClick={() => attemptDesktopInviteHandoff(desktopMemberJoinLink(offer))}>
                  {t('e2ee.team.openDesktop')}
                </Button>
              )}
              {accountId &&
                emailVerified &&
                native &&
                !recovering &&
                !ready &&
                !terminal &&
                pinMatches &&
                available?.matchesRecipient !== false &&
                !request && (
                  <Button disabled={busy} onClick={() => void accept()}>
                    {t(offer.mode === 'email' ? 'e2ee.team.accept' : 'e2ee.team.submit')}
                  </Button>
                )}
              {request && !ready && !terminal && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setRetry((value) => value + 1);
                    void accept();
                  }}
                >
                  {t('e2ee.team.retry')}
                </Button>
              )}
              {ready && (
                <Button
                  onClick={() =>
                    onWorkspaceRequested(available?.workspaceSlug ?? null, offer.workspaceId)
                  }
                >
                  {t('e2ee.team.openWorkspace')}
                </Button>
              )}
              {available?.matchesRecipient === false && !request && (
                <Button variant="secondary" onClick={onEmailVerificationRequested}>
                  {t('e2ee.team.switchAccount')}
                </Button>
              )}
              <Button variant="secondary" onClick={onHomeRequested}>
                {t('e2ee.team.home')}
              </Button>
            </div>
          </div>
        </Card.Root>
      </div>
    </main>
  );
}
