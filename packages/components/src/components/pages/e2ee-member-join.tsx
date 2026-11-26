import {
  isLocalStorageFailure,
  isRequestUnavailable,
  requestFailureCode,
} from '@/lib/e2ee-actionable-failure';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { useCloudQueryState, usePlatform } from '@lody/platform/react';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import type { E2eeMemberOffer, E2eeMemberReplies } from '@lody/cloud-api';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Spinner } from '@lody/ui/spinner';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Check } from 'lucide-react';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { useStableSession } from '@/hooks/useStableSession';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { desktopMemberJoinLink, sameMemberOffer } from '@/lib/e2ee-member-offer';
import {
  attemptDesktopInviteHandoff,
  canAttemptDesktopInviteHandoff,
} from '@/lib/desktop-invite-deep-link';

const DESKTOP_DOWNLOAD_URL = 'https://lody.ai/download';

const styles = stylex.create({
  page: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    padding: space[4],
    backgroundColor: colors.background,
  },
  card: { width: '100%', maxWidth: 460 },
  stack: { display: 'flex', flexDirection: 'column', gap: space[4] },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  steps: {
    listStyle: 'none',
    margin: 0,
    paddingBlock: space[3],
    paddingInline: space[3],
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.separator,
    display: 'flex',
    flexDirection: 'column',
  },
  step: { display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', columnGap: space[3] },
  rail: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  dot: {
    width: 20,
    height: 20,
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    fontSize: text.captionSize,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    backgroundColor: colors.elevatedBackground,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.separator,
    color: colors.tertiaryLabel,
  },
  dotDone: { backgroundColor: colors.success, borderColor: colors.success, color: '#ffffff' },
  dotCurrent: {
    backgroundColor: colors.label,
    borderColor: colors.label,
    color: colors.background,
  },
  line: { width: '1.5px', flexGrow: 1, minHeight: space[3], backgroundColor: colors.separator },
  lineDone: { backgroundColor: colors.success },
  stepText: {
    paddingBottom: space[3],
    fontSize: text.subheadlineSize,
    lineHeight: '20px',
    color: colors.tertiaryLabel,
  },
  stepTextLast: { paddingBottom: 0 },
  stepTextActive: { color: colors.label },
  stepTextCurrent: { fontWeight: 600 },
  signedInBar: {
    margin: 0,
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: radius.small,
    backgroundColor: colors.secondaryBackground,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.separator,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  waitingPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.separator,
  },
  waitingTitle: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  muted: {
    margin: 0,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  link: { color: colors.label, textDecoration: 'underline', textUnderlineOffset: '3px' },
});

const JOIN_STEPS = ['accept', 'approval', 'key', 'open'] as const;

/** One card, four steps: where the request is and whom it waits on. Display only. */
function JoinProgress(props: { current: number }) {
  const { t } = useTranslation();
  return (
    <ol aria-label={t('e2ee.team.progress')} {...stylex.props(styles.steps)}>
      {JOIN_STEPS.map((step, index) => {
        const done = index < props.current;
        const current = index === props.current;
        return (
          <li
            key={step}
            data-join-step={step}
            aria-current={current ? 'step' : undefined}
            {...stylex.props(styles.step)}
          >
            <span {...stylex.props(styles.rail)}>
              <span
                {...stylex.props(styles.dot, done && styles.dotDone, current && styles.dotCurrent)}
              >
                {done ? <Check size={12} aria-hidden="true" /> : index + 1}
              </span>
              {index < JOIN_STEPS.length - 1 && (
                <span {...stylex.props(styles.line, done && styles.lineDone)} />
              )}
            </span>
            <span
              {...stylex.props(
                styles.stepText,
                index === JOIN_STEPS.length - 1 && styles.stepTextLast,
                (done || current) && styles.stepTextActive,
                current && styles.stepTextCurrent
              )}
            >
              {t(`e2ee.team.steps.${step}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
type Runtime = Pick<
  E2eeWorkspaceRuntime,
  'prepareMemberJoin' | 'pendingMemberJoin' | 'claimMemberJoin'
>;
type Props = {
  offer: E2eeMemberOffer;
  runtime?: Runtime;
  watchClaim?: boolean;
  accountId: string | null;
  email?: string;
  emailVerified?: boolean;
  loading?: boolean;
  preview?: E2eeMemberReplies['preview'];
  previewError?: unknown;
  onRetryPreview?: () => void;
  onSignInRequested: () => void;
  onEmailVerificationRequested: () => void;
  onWorkspaceRequested: (workspaceSlug: string | null, workspaceId?: string) => void;
  onHomeRequested: () => void;
};
const CLAIM_INTERVAL_MS = 10_000;
/** While the request is committed and the key not yet installed. */
const KEY_WAIT_INTERVALS_MS = [500, 1000, 2000, 3000];
/** Upper bound of the faster cadence, after which claims return to 10 s. */
const KEY_WAIT_FAST_MS = 120_000;
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
  const {
    data: preview,
    error: previewError,
    retry: retryPreview,
  } = useCloudQueryState(cloudOperations.e2eeMembers.preview, { token: props.offer.token });
  const sessionLoading = session.isPending || session.isRetrying || session.isOptimistic;
  return (
    <E2eeMemberJoin
      {...props}
      runtime={platform.e2eeWorkspaces?.runtime}
      watchClaim
      accountId={session.data?.user.id ?? null}
      email={session.data?.user.email}
      emailVerified={session.isOptimistic ? undefined : session.data?.user.emailVerified}
      loading={sessionLoading}
      preview={preview}
      previewError={previewError}
      onRetryPreview={retryPreview}
    />
  );
}
function memberJoinFailureKey(cause: unknown) {
  if (isLocalStorageFailure(cause)) return 'e2ee.team.error.storage';
  if (
    /^(?:e2ee_)?(?:invite|invitation|member_invitation|member_join)_(?:expired|invalid|not_found|unavailable|rejected)$/.test(
      requestFailureCode(cause) ?? ''
    )
  )
    return 'e2ee.team.unavailable';
  if (isRequestUnavailable(cause)) return 'e2ee.team.error.network';
  return 'e2ee.team.retryOriginal';
}
function MemberClaimHint({
  workspaceId,
  requestId,
  wake,
}: {
  workspaceId: string;
  requestId: string;
  wake: RefObject<((reset?: boolean) => void) | undefined>;
}) {
  const { data } = useCloudQueryState(cloudOperations.e2eeMembers.claim, {
    workspaceId,
    requestId,
  });
  const state = data?.state;
  const lastState = useRef<typeof state>(undefined);
  useEffect(() => {
    if (!state || lastState.current === state) return;
    lastState.current = state;
    // Relay status only wakes the host. The original claim still verifies admission and keys.
    if (state !== 'pending') wake.current?.();
  }, [state, wake]);
  return null;
}

export function E2eeMemberJoin(props: Props) {
  return <JoinSession key={`${props.accountId}:${props.offer.token}`} {...props} />;
}
function JoinSession({
  offer,
  runtime,
  watchClaim,
  accountId,
  email,
  emailVerified,
  preview,
  previewError,
  onRetryPreview,
  loading,
  onSignInRequested,
  onEmailVerificationRequested,
  onWorkspaceRequested,
  onHomeRequested,
}: Props) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<{ requestId: string; state: string } | null>(null);
  const [ready, setReady] = useState(false);
  // A resumed join the host reports as already joined shows as joined at once; one claim
  // still runs to confirm it, and its answer replaces the hint.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(Boolean(accountId && runtime?.pendingMemberJoin));
  const [error, setError] = useState<ReturnType<typeof memberJoinFailureKey> | null>(null);
  const [checkingKey, setCheckingKey] = useState(false);
  const wake = useRef<((reset?: boolean) => void) | undefined>(undefined);
  // The fast claim window ended while committed: say why the member is still waiting.
  const [slowWait, setSlowWait] = useState(false);
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
        if (!disposed && pending?.requestId && sameMemberOffer(pending.offer, offer)) {
          setRequest({
            requestId: pending.requestId,
            state: pending.joined ? 'committed' : 'pending',
          });
          if (pending.joined) {
            setReady(true);
            setUnconfirmed(true);
          }
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(memberJoinFailureKey(cause));
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
  const claimActive = Boolean(
    requestId && runtime?.claimMemberJoin && (!ready || unconfirmed) && !requestTerminal
  );
  useEffect(() => {
    if (!requestId || !runtime?.claimMemberJoin || !claimActive) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    let wakePending = false;
    let committedSince: number | undefined;
    let keyWaitAttempt = 0;
    setSlowWait(false);
    const claim = async () => {
      let delay = CLAIM_INTERVAL_MS;
      checking = true;
      setCheckingKey(true);
      try {
        const result = await runtime.claimMemberJoin!(offer.workspaceId, requestId);
        if (disposed) return;
        setRequest((previous) =>
          previous?.requestId === requestId ? { ...previous, state: result.state } : previous
        );
        setReady(result.ready);
        setUnconfirmed(false);
        setError(null);
        if (result.ready || ['rejected', 'cancelled'].includes(result.state)) return;
        if (result.state === 'committed') {
          committedSince ??= Date.now();
          if (Date.now() - committedSince < KEY_WAIT_FAST_MS) {
            delay = KEY_WAIT_INTERVALS_MS[keyWaitAttempt]!;
            keyWaitAttempt = Math.min(keyWaitAttempt + 1, KEY_WAIT_INTERVALS_MS.length - 1);
          } else setSlowWait(true);
        }
      } catch (cause) {
        if (!disposed) setError(memberJoinFailureKey(cause));
      } finally {
        checking = false;
        if (!disposed) setCheckingKey(false);
      }
      if (disposed) return;
      if (wakePending) {
        wakePending = false;
        void claim();
      } else {
        timer = setTimeout(() => void claim(), delay);
      }
    };
    const recheck = (reset = false) => {
      clearTimeout(timer);
      if (reset) {
        committedSince = undefined;
        keyWaitAttempt = 0;
        setSlowWait(false);
      }
      if (checking) wakePending = true;
      else void claim();
    };
    const reconnect = () => recheck(true);
    wake.current = recheck;
    window.addEventListener('online', reconnect);
    void claim();
    return () => {
      disposed = true;
      wake.current = undefined;
      clearTimeout(timer);
      window.removeEventListener('online', reconnect);
    };
  }, [runtime, offer.workspaceId, requestId, claimActive]);
  const accept = async () => {
    if (working.current || !runtime?.prepareMemberJoin) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.prepareMemberJoin(offer);
      if (current()) setRequest({ requestId: result.requestId, state: result.state });
    } catch (cause) {
      if (current()) setError(memberJoinFailureKey(cause));
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
  const terminal = requestTerminal;
  const previewFailed = Boolean(previewError) && preview === undefined && !request;
  const previewFailure = previewFailed ? memberJoinFailureKey(previewError) : null;
  let message = 'e2ee.team.joinHelp';
  if (loading || recovering || (preview === undefined && !previewFailed && !request))
    message = 'e2ee.team.loading';
  else if (previewFailure)
    message =
      previewFailure === 'e2ee.team.error.network' ? 'invite.error.network' : previewFailure;
  else if (!accountId) message = 'e2ee.team.signInHelp';
  else if (!emailVerified) message = 'e2ee.team.verifyHelp';
  else if (!native) message = runtime ? 'e2ee.team.joinUpgrade' : 'e2ee.team.desktopRequired';
  else if (ready) message = 'e2ee.team.ready';
  else if (terminal) message = 'e2ee.team.rejected';
  else if (request?.state === 'committed') message = 'e2ee.team.waitingKey';
  else if (request) message = 'e2ee.team.waitingApproval';
  else if (!pinMatches) message = 'e2ee.team.unavailable';
  else if (available?.matchesRecipient === false) message = 'e2ee.team.wrongEmail';
  const canOpenDesktop = canAttemptDesktopInviteHandoff();
  const descriptionText =
    message === 'e2ee.team.wrongEmail' && available?.recipientEmailMasked
      ? t('e2ee.team.wrongEmailFor', { invited: available.recipientEmailMasked })
      : message === 'e2ee.team.desktopRequired' && !canOpenDesktop
        ? t('e2ee.team.mobileBrowserUnsupported')
        : t(message);
  return (
    <main data-testid="e2ee-invitation" {...stylex.props(styles.page)}>
      {watchClaim && accountId && requestId && claimActive && (
        <MemberClaimHint
          key={requestId}
          workspaceId={offer.workspaceId}
          requestId={requestId}
          wake={wake}
        />
      )}
      <div {...stylex.props(styles.card)}>
        <Card.Root>
          <Card.Header>
            <Card.Title as="h1">
              {available?.workspaceName
                ? t('e2ee.team.joinTitle', { workspace: available.workspaceName })
                : t('e2ee.team.join')}
            </Card.Title>
            {message !== 'e2ee.team.waitingKey' && (
              <Card.Description>{descriptionText}</Card.Description>
            )}
          </Card.Header>
          <div {...stylex.props(styles.stack)}>
            {!loading &&
              accountId &&
              emailVerified &&
              native &&
              (pinMatches || request) &&
              !terminal && (
                <JoinProgress
                  current={ready ? 4 : request?.state === 'committed' ? 2 : request ? 1 : 0}
                />
              )}
            {!accountId && !loading && !previewError && !native && !runtime && (
              <p {...stylex.props(styles.muted)}>
                {t('e2ee.team.desktopHint')}{' '}
                <a
                  href={DESKTOP_DOWNLOAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  {...stylex.props(styles.link)}
                >
                  {t('e2ee.team.downloadDesktop')}
                </a>
              </p>
            )}
            {email && (
              <p {...stylex.props(styles.signedInBar)}>{t('e2ee.team.signedInAs', { email })}</p>
            )}
            {message === 'e2ee.team.waitingKey' ? (
              <div {...stylex.props(styles.waitingPanel)}>
                <h2 {...stylex.props(styles.waitingTitle)}>{t(message)}</h2>
                <p {...stylex.props(styles.muted)}>{t('e2ee.team.waitingKeyGuide')}</p>
                {error ? (
                  <p role="status" {...stylex.props(styles.muted)}>
                    {t(error)}
                  </p>
                ) : (
                  slowWait && (
                    <p role="status" {...stylex.props(styles.muted)}>
                      {t('e2ee.team.waitingKeySlow')}
                    </p>
                  )
                )}
                <div {...stylex.props(styles.actions)}>
                  <Button disabled={checkingKey} onClick={() => wake.current?.(true)}>
                    {checkingKey && <Spinner size="small" />}
                    {t('e2ee.team.checkKeyAgain')}
                  </Button>
                </div>
              </div>
            ) : (
              error && (
                <p role="status" {...stylex.props(styles.muted)}>
                  {t(error)}
                </p>
              )
            )}
            <div {...stylex.props(styles.actions)}>
              {previewFailed && previewFailure !== 'e2ee.team.unavailable' && onRetryPreview && (
                <Button onClick={onRetryPreview}>{t('e2ee.team.retry')}</Button>
              )}
              {!accountId && !loading && !previewError && (
                <Button onClick={onSignInRequested}>{t('e2ee.team.signIn')}</Button>
              )}
              {!loading && accountId && !emailVerified && (
                <Button onClick={onEmailVerificationRequested}>{t('e2ee.team.verify')}</Button>
              )}
              {!loading && accountId && emailVerified && !native && !runtime && canOpenDesktop && (
                <>
                  <Button onClick={() => attemptDesktopInviteHandoff(desktopMemberJoinLink(offer))}>
                    {t('e2ee.team.openDesktop')}
                  </Button>
                  <Button
                    variant="secondary"
                    render={
                      <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" />
                    }
                  >
                    {t('e2ee.team.downloadDesktop')}
                  </Button>
                </>
              )}
              {!loading &&
                accountId &&
                emailVerified &&
                native &&
                !recovering &&
                !ready &&
                !terminal &&
                pinMatches &&
                available?.matchesRecipient !== false &&
                !request && (
                  <Button
                    data-testid="e2ee-invitation-submit"
                    disabled={busy}
                    onClick={() => void accept()}
                  >
                    {t(offer.mode === 'email' ? 'e2ee.team.accept' : 'e2ee.team.submit')}
                  </Button>
                )}
              {!loading && request && request.state !== 'committed' && !ready && !terminal && (
                <Button
                  variant="secondary"
                  disabled={checkingKey}
                  onClick={() => {
                    wake.current?.(true);
                  }}
                >
                  {checkingKey && <Spinner size="small" />}
                  {t('e2ee.team.checkStatus')}
                </Button>
              )}
              {!loading && ready && (
                <Button
                  onClick={() =>
                    onWorkspaceRequested(available?.workspaceSlug ?? null, offer.workspaceId)
                  }
                >
                  {t('e2ee.team.openWorkspace')}
                </Button>
              )}
              {!loading &&
                !recovering &&
                accountId &&
                emailVerified &&
                available?.matchesRecipient === false &&
                !request && (
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
