import { managementFailureKind } from '@/lib/e2ee-actionable-failure';
import { seatBillingErrorKey } from './billing-errors';
import {
  hostLedgerHistory,
  bytesToHex,
  type VerifiedLedgerHistory,
} from '@/lib/e2ee-ledger-history';
import { e2eeErrorCode } from '@/lib/e2ee-admission-refusals';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { getServerNow } from '@lody/shared';
import type { E2eeMemberKeyDelivery, E2eeWorkspaceRuntime } from '@lody/platform';
import type { E2eeMemberOffer, E2eeMemberReplies } from '@lody/cloud-api';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Card } from '@lody/ui/card';
import { Spinner } from '@lody/ui/spinner';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { useReferralPolicyRefresh } from '@/hooks/use-referral-policy-refresh';
import { getAppShareUrl } from '@/lib/app-location';
import { copyTextToClipboard } from '@/lib/clipboard';
import { memberJoinPath } from '@/lib/e2ee-member-offer';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { SeatCostNotice, SeatAdmissionActions, isSeatAdmissionReady } from './invite-member-dialog';

type Runtime = Pick<
  E2eeWorkspaceRuntime,
  | 'createMemberInvitation'
  | 'memberJoinRequests'
  | 'approveMemberJoin'
  | 'rejectMemberJoin'
  | 'revokeMemberInvitation'
  | 'setMemberRole'
> &
  Partial<
    Pick<
      E2eeWorkspaceRuntime,
      'memberKeyDeliveries' | 'retryMemberKeyDelivery' | 'subscribePendingMemberRequests'
    >
  >;
/** Approval refused because the free workspace is full, as the refreshed list reports. */
class MemberLimitReached extends Error {}

const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: space[3] },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    paddingTop: '20px',
    marginTop: space[1],
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  sectionHeading: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    letterSpacing: '-0.005em',
    color: colors.label,
  },
  statusMessage: {
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: colors.secondaryBackground,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.label,
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  listRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    paddingBlock: space[1],
  },
  actionGroup: {
    display: 'inline-flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
  },
  requestList: { display: 'flex', flexDirection: 'column', gap: space[2] },
  requestCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[3],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: colors.secondaryBackground,
    boxShadow: `inset 0 0 0 1px ${colors.separator}`,
  },
  requestHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  identityBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  // The address and its send button stay on one line.
  inviteRow: { display: 'flex', alignItems: 'center', gap: space[2] },
  inviteField: { flexGrow: 1, minWidth: 0 },
  approveCost: {
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  memberLimit: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.warning,
  },
  identity: {
    flexGrow: 1,
    flexBasis: '10rem',
    minWidth: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    color: colors.label,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  label: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  emptyNote: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  fingerprintRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  busy: { display: 'inline-flex', alignItems: 'center', gap: space[2] },
  code: {
    display: 'inline-flex',
    alignItems: 'center',
    paddingInline: space[1.5],
    paddingBlock: '2px',
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    backgroundColor: colors.wellBackground,
    boxShadow: `inset 0 0 0 1px ${colors.separator}`,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '0.03em',
    overflowWrap: 'anywhere',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.label,
  },
});
/** First 16 hex digits in groups of four: what an applicant reads aloud to compare. */
const deviceFingerprint = (key: string) =>
  key
    .slice(0, 16)
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1 ');

export const memberInvitationUrl = (offer: E2eeMemberOffer) =>
  getAppShareUrl(memberJoinPath(offer));

function KeyDeliveryRetry({ retry }: { retry?: () => Promise<void> }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('e2ee.team.keyFailed');
  const running = useRef(false);
  const run = async () => {
    if (!retry || running.current) return;
    running.current = true;
    setMessage('e2ee.team.keyRetrying');
    try {
      await retry();
      setMessage('e2ee.team.keyFailed');
    } catch (error) {
      const kind = managementFailureKind(error);
      setMessage(`e2ee.team.keyRetryError.${kind === 'conflict' ? 'generic' : kind}`);
    } finally {
      running.current = false;
    }
  };
  return (
    <>
      <span role="status" {...stylex.props(styles.label)}>
        {t(message)}
      </span>
      {retry && (
        <Button
          variant="secondary"
          size="small"
          disabled={message === 'e2ee.team.keyRetrying'}
          onClick={() => void run()}
        >
          {t('e2ee.team.keyRetry')}
        </Button>
      )}
    </>
  );
}

type Member = { membershipId: string; role: string; name?: string };
export function E2eeTeamSettings(props: {
  runtime: Runtime;
  workspaceId: string;
  canPromote?: boolean;
  members?: Member[];
  onOpenBilling?: () => void;
  onRefreshBilling?: () => Promise<unknown>;
  onMembersChanged?: () => Promise<void>;
}) {
  return <TeamSession key={props.workspaceId} {...props} />;
}
function TeamSession({
  runtime,
  workspaceId,
  canPromote,
  members,
  onOpenBilling,
  onRefreshBilling,
  onMembersChanged,
}: {
  runtime: Runtime;
  workspaceId: string;
  canPromote?: boolean;
  members?: Member[];
  onOpenBilling?: () => void;
  onRefreshBilling?: () => Promise<unknown>;
  onMembersChanged?: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  // Product language, not the OS locale.
  const formatExpiry = (value: number | string) =>
    new Intl.DateTimeFormat(toIntlLocaleOrEn(i18n?.language), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  const [data, setData] = useState<E2eeMemberReplies['pending'] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<E2eeMemberKeyDelivery[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Applicants leave the request list once committed; keep their label for delivery rows.
  const applicants = useRef(new Map<string, string>());
  const owner = useRef(runtime);
  owner.current = runtime;
  const live = useRef(true);
  const working = useRef(false);
  const current = () => live.current && owner.current === runtime;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(copiedTimer.current);
    };
  }, []);
  const copyLink = async (key: string, value: string) => {
    try {
      await copyTextToClipboard(value);
      if (!current()) return;
      clearTimeout(copiedTimer.current);
      setCopiedKey(key);
      copiedTimer.current = setTimeout(() => {
        if (current()) setCopiedKey((prev) => (prev === key ? null : prev));
      }, 2_000);
    } catch {
      /* Clipboard denial leaves the input selectable. */
    }
  };
  const remember = (value: E2eeMemberReplies['pending']) => {
    for (const item of value.items)
      applicants.current.set(
        item.requestId,
        item.applicantName || item.applicantEmail || t('e2ee.team.applicant')
      );
  };
  const refresh = async () => {
    const [requestsResult, deliveriesResult] = await Promise.allSettled([
      runtime.memberJoinRequests!(workspaceId),
      runtime.memberKeyDeliveries?.(workspaceId) ?? Promise.resolve(undefined),
    ]);
    if (requestsResult.status === 'fulfilled') {
      remember(requestsResult.value);
      if (current()) {
        setData(requestsResult.value);
        setMessage((prev) => (prev === t('e2ee.team.loadFailed') ? null : prev));
      }
    }
    if (deliveriesResult.status === 'fulfilled' && deliveriesResult.value && current())
      setDeliveries(deliveriesResult.value.items);
    if (requestsResult.status === 'rejected') throw requestsResult.reason;
  };
  const perform = async (action: () => Promise<void>, approval = false) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      const kind = managementFailureKind(error);
      const messageKey =
        kind === 'unauthorized' || kind === 'conflict'
          ? `e2ee.team.error.${kind}`
          : approval
            ? 'e2ee.team.retryOriginal'
            : kind === 'generic'
              ? 'e2ee.team.error.actionFailed'
              : 'e2ee.team.error.actionNetwork';
      if (current())
        setMessage(
          t(
            error instanceof MemberLimitReached
              ? 'e2ee.team.memberLimit'
              : (seatBillingErrorKey(error) ??
                  // An applicant of the unsigned invitation for this email is still waiting.
                  (e2eeErrorCode(error) === 'e2ee_member_invitation_request_pending'
                    ? 'e2ee.team.invitationRequestPending'
                    : messageKey))
          )
        );
    } finally {
      working.current = false;
      if (current()) setBusy(false);
    }
  };
  const triggerReadRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!runtime.memberJoinRequests) {
      triggerReadRef.current = null;
      return undefined;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let queued = false;
    const schedule = () => {
      clearTimeout(timer);
      if (!disposed) timer = setTimeout(() => void read(), 10_000);
    };
    const read = async () => {
      if (disposed) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      clearTimeout(timer);
      try {
        do {
          queued = false;
          const [requestsResult, deliveriesResult] = await Promise.allSettled([
            runtime.memberJoinRequests!(workspaceId),
            runtime.memberKeyDeliveries?.(workspaceId) ?? Promise.resolve(undefined),
          ]);
          if (disposed) return;
          if (requestsResult.status === 'fulfilled') {
            remember(requestsResult.value);
            setData(requestsResult.value);
            setMessage((prev) => (prev === t('e2ee.team.loadFailed') ? null : prev));
          } else {
            setMessage(t('e2ee.team.loadFailed'));
          }
          if (deliveriesResult.status === 'fulfilled' && deliveriesResult.value) {
            setDeliveries(deliveriesResult.value.items);
          }
        } while (queued && !disposed);
      } finally {
        inFlight = false;
        schedule();
      }
    };
    triggerReadRef.current = () => {
      if (!disposed) void read();
    };
    const unsubscribe = runtime.subscribePendingMemberRequests?.(workspaceId, () => {
      if (!disposed) void read();
    });
    const onVisibilityOrFocus = () => {
      if (!disposed && document.visibilityState !== 'hidden') void read();
    };
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    void read();
    return () => {
      disposed = true;
      triggerReadRef.current = null;
      clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
    };
  }, [runtime, workspaceId, t]);
  const [seatPolicyRefreshKey, refreshSeatPolicy] = useState(0);
  useReferralPolicyRefresh(
    data?.seatPreview?.status === 'billed'
      ? (data.seatPreview.policyNextChangeAt ?? data.seatPreview.promoEndsAt)
      : undefined,
    refreshSeatPolicy
  );
  useEffect(() => {
    if (seatPolicyRefreshKey > 0) triggerReadRef.current?.();
  }, [seatPolicyRefreshKey]);
  const hasInFlightDeliveries = deliveries.some(
    (delivery) => delivery.state === 'pending' || delivery.state === 'delivering'
  );
  useEffect(() => {
    if (!hasInFlightDeliveries || !runtime.memberKeyDeliveries) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (disposed) return;
      try {
        const result = await runtime.memberKeyDeliveries!(workspaceId);
        if (!disposed) setDeliveries(result.items);
      } catch {
        // Ignored; the 10s poll retries.
      }
      if (!disposed) timer = setTimeout(() => void poll(), 500);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [hasInFlightDeliveries, runtime, workspaceId]);
  if (
    !runtime.createMemberInvitation ||
    !runtime.memberJoinRequests ||
    !runtime.approveMemberJoin ||
    !runtime.rejectMemberJoin ||
    !runtime.revokeMemberInvitation
  )
    return <p>{t('e2ee.team.upgrade')}</p>;
  const create = (mode: 'email' | 'link') =>
    perform(async () => {
      const offer = await runtime.createMemberInvitation!({
        workspaceId,
        mode,
        ...(mode === 'email' ? { email } : {}),
      });
      if (current()) {
        if (mode === 'email') setEmail('');
        setLink(memberInvitationUrl(offer));
        setMessage(t(mode === 'email' ? 'e2ee.team.emailSent' : 'e2ee.team.linkReady'));
      }
      await refresh();
    });
  // Approval adds a paid seat: say so beside the approve button, not only at the top.
  const seat = data?.seatPreview;
  const seatPromoExpired =
    seat?.status === 'billed' && seat.promoEndsAt != null && getServerNow() >= seat.promoEndsAt;
  const effectiveApprovalProrated =
    seat?.status === 'billed'
      ? seatPromoExpired && seat.regularProratedAmount != null
        ? seat.regularProratedAmount
        : seat.proratedAmount
      : null;
  const approvalCost =
    seat?.status === 'billed'
      ? effectiveApprovalProrated === null
        ? t('e2ee.team.approveCostUnknown')
        : t('e2ee.team.approveCost', {
            amount: new Intl.NumberFormat(toIntlLocaleOrEn(i18n?.language), {
              style: 'currency',
              currency: seat.currency ?? 'usd',
            }).format(effectiveApprovalProrated / 100),
          })
      : null;
  const hasPendingRequests = (data?.items.length ?? 0) > 0;
  const activeDeliveries = deliveries.filter((delivery) => delivery.state !== 'delivered');
  const hasBillingNotice = !(
    data?.seatPreview?.status === 'not_billed' && data.seatPreview.reason === 'free'
  );
  const hasBillingActions =
    data?.seatPreview?.status === 'billed' && Boolean(data.seatPreview.paymentAction);
  const requestsSection = (
    <div {...stylex.props(styles.section)}>
      <h3 {...stylex.props(styles.sectionHeading)}>{t('e2ee.team.requests')}</h3>
      {data?.items.length === 0 && (
        <p {...stylex.props(styles.emptyNote)}>{t('e2ee.team.noRequests')}</p>
      )}
      {hasPendingRequests && (
        <div {...stylex.props(styles.requestList)}>
          {data?.items.map((request) => (
            <div
              data-testid="e2ee-join-request"
              data-request-id={request.requestId}
              key={request.requestId}
              {...stylex.props(styles.requestCard)}
            >
              <div {...stylex.props(styles.identityBlock)}>
                <div {...stylex.props(styles.requestHeader)}>
                  <span {...stylex.props(styles.identity)}>
                    {request.applicantName || request.applicantEmail || t('e2ee.team.applicant')}
                  </span>
                  <Badge tone="warning" data-testid="e2ee-join-admission-mode">
                    {t('e2ee.team.approvalRequired')}
                  </Badge>
                </div>
                {request.applicantEmail && (
                  <span {...stylex.props(styles.label)}>{request.applicantEmail}</span>
                )}
              </div>
              <div {...stylex.props(styles.fingerprintRow)}>
                <span>{t('e2ee.team.deviceKey')}</span>
                <code title={request.signingPublicKey} {...stylex.props(styles.code)}>
                  {deviceFingerprint(request.signingPublicKey)}
                </code>
              </div>
              {request.state === 'pending' && request.memberLimitReached ? (
                <span data-testid="e2ee-join-member-limit" {...stylex.props(styles.memberLimit)}>
                  {t('e2ee.team.memberLimit')}
                </span>
              ) : (
                request.state === 'pending' &&
                approvalCost && (
                  <span data-testid="e2ee-join-approve-cost" {...stylex.props(styles.approveCost)}>
                    {approvalCost}
                  </span>
                )
              )}
              <div {...stylex.props(styles.actionGroup)}>
                <Button
                  size="small"
                  data-testid="e2ee-join-approve"
                  data-request-id={request.requestId}
                  disabled={
                    busy ||
                    (request.state === 'pending' &&
                      (!!request.memberLimitReached || !isSeatAdmissionReady(data?.seatPreview)))
                  }
                  aria-busy={approving === request.requestId || undefined}
                  onClick={() =>
                    void perform(async () => {
                      if (
                        request.state === 'pending' &&
                        (request.memberLimitReached || !isSeatAdmissionReady(data?.seatPreview))
                      )
                        return;
                      setApproving(request.requestId);
                      let admitted = false;
                      try {
                        const result = await runtime.approveMemberJoin!(
                          workspaceId,
                          request.requestId,
                          'explicit'
                        );
                        admitted = result.admitted;
                        if (current()) {
                          setMessage(
                            t(result.admitted ? 'e2ee.team.admitted' : 'e2ee.team.reconciling')
                          );
                          if (result.admitted) {
                            setData((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    items: prev.items.filter(
                                      (item) => item.requestId !== request.requestId
                                    ),
                                  }
                                : prev
                            );
                            if (result.keyDelivery && result.keyDelivery !== 'delivered') {
                              const nextState = result.keyDelivery;
                              setDeliveries((prev) =>
                                prev.some((item) => item.requestId === request.requestId)
                                  ? prev
                                  : [...prev, { requestId: request.requestId, state: nextState }]
                              );
                            }
                          }
                        }
                      } catch (error) {
                        // The workspace may have filled since the list was read: the relay
                        // then refuses the signed admission, and the fresh list says why.
                        const fresh = await runtime.memberJoinRequests!(workspaceId).catch(
                          () => null
                        );
                        if (fresh) {
                          remember(fresh);
                          if (current()) setData(fresh);
                        }
                        if (
                          fresh?.items.some(
                            (item) =>
                              item.requestId === request.requestId && item.memberLimitReached
                          )
                        )
                          throw new MemberLimitReached();
                        throw error;
                      } finally {
                        if (current()) setApproving(null);
                      }
                      if (admitted) {
                        void Promise.allSettled([onMembersChanged?.(), refresh()]);
                      } else {
                        await refresh();
                      }
                    }, true)
                  }
                >
                  {approving === request.requestId ? (
                    <span {...stylex.props(styles.busy)}>
                      <Spinner size="small" label={null} />
                      {t('e2ee.team.submitting')}
                    </span>
                  ) : (
                    t('e2ee.team.approve')
                  )}
                </Button>
                {request.state === 'pending' && (
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await runtime.rejectMemberJoin!(workspaceId, request.requestId);
                        await refresh();
                      })
                    }
                  >
                    {t('e2ee.team.reject')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {data?.hasMore && <p {...stylex.props(styles.emptyNote)}>{t('e2ee.team.moreRequests')}</p>}
    </div>
  );
  return (
    <Card.Root data-testid="e2ee-team-settings">
      <Card.Header>
        <Card.Title>{t('e2ee.team.title')}</Card.Title>
        <Card.Description>{t('e2ee.team.help')}</Card.Description>
      </Card.Header>
      <div {...stylex.props(styles.stack)}>
        {message && (
          <p role="status" {...stylex.props(styles.statusMessage)}>
            {message}
          </p>
        )}
        <form
          {...stylex.props(styles.inviteRow)}
          onSubmit={(event) => {
            event.preventDefault();
            void create('email');
          }}
        >
          <div {...stylex.props(styles.inviteField)}>
            <Input
              type="email"
              required
              aria-label={t('e2ee.team.email')}
              placeholder={t('e2ee.team.email')}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
          </div>
          <Button
            variant={
              isSeatAdmissionReady(data?.seatPreview) && !hasPendingRequests
                ? 'primary'
                : 'secondary'
            }
            data-testid="e2ee-invite-email"
            type="submit"
            disabled={busy || !data}
          >
            {t('e2ee.team.invite')}
          </Button>
        </form>
        <div {...stylex.props(styles.row)}>
          <Button
            data-testid="e2ee-invite-link-create"
            variant="secondary"
            size="small"
            disabled={busy || !data}
            onClick={() => void create('link')}
          >
            {t('e2ee.team.createLink')}
          </Button>
          <span {...stylex.props(styles.label)}>{t('e2ee.team.linkHelp')}</span>
        </div>
        {link && (
          <div {...stylex.props(styles.inviteRow)}>
            <div {...stylex.props(styles.inviteField)}>
              <Input
                data-testid="e2ee-invitation-link"
                aria-label={t('e2ee.team.invitationLink')}
                readOnly
                value={link}
                onFocus={(event) => event.target.select()}
              />
            </div>
            <Button
              data-testid="e2ee-invitation-link-copy"
              variant="secondary"
              size="small"
              onClick={() => void copyLink('link', link)}
            >
              {t(copiedKey === 'link' ? 'e2ee.team.copied' : 'e2ee.team.copyLink')}
            </Button>
          </div>
        )}
        {hasPendingRequests && requestsSection}
        {hasBillingNotice || hasBillingActions ? (
          <div {...stylex.props(styles.section)}>
            <SeatCostNotice preview={data?.seatPreview} />
            {hasBillingActions && (
              <div {...stylex.props(styles.row)}>
                <SeatAdmissionActions
                  preview={data?.seatPreview}
                  pending={busy}
                  onOpenBilling={onOpenBilling}
                  onRefresh={
                    onRefreshBilling
                      ? () =>
                          void perform(async () => {
                            try {
                              await onRefreshBilling();
                            } finally {
                              await refresh();
                            }
                          })
                      : undefined
                  }
                />
              </div>
            )}
          </div>
        ) : (
          <SeatCostNotice preview={data?.seatPreview} />
        )}
        {!hasPendingRequests && requestsSection}
        {activeDeliveries.length > 0 && (
          <div {...stylex.props(styles.section)}>
            {activeDeliveries.map((delivery) => (
              <div
                data-testid="e2ee-key-delivery"
                data-key-delivery-id={delivery.requestId}
                key={delivery.requestId}
                {...stylex.props(styles.listRow)}
              >
                <span {...stylex.props(styles.identity)}>
                  {applicants.current.get(delivery.requestId) ?? t('e2ee.team.applicant')}
                </span>
                {delivery.state === 'failed' ? (
                  <div {...stylex.props(styles.actionGroup)}>
                    <KeyDeliveryRetry
                      retry={
                        runtime.retryMemberKeyDelivery
                          ? async () => {
                              const next = await runtime.retryMemberKeyDelivery!(
                                workspaceId,
                                delivery.requestId
                              );
                              if (current())
                                setDeliveries((items) =>
                                  items.map((item) =>
                                    item.requestId === next.requestId ? next : item
                                  )
                                );
                            }
                          : undefined
                      }
                    />
                  </div>
                ) : (
                  <span role="status" {...stylex.props(styles.busy, styles.label)}>
                    <Spinner size="small" label={null} />
                    {t('e2ee.team.keySending')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {canPromote &&
          runtime.setMemberRole &&
          members?.some((member) => member.role === 'member') && (
            <div {...stylex.props(styles.section)}>
              <h3 {...stylex.props(styles.sectionHeading)}>{t('e2ee.team.admins')}</h3>
              {members
                .filter((member) => member.role === 'member')
                .map((member) => (
                  <div key={member.membershipId} {...stylex.props(styles.listRow)}>
                    <span {...stylex.props(styles.identity)}>
                      {member.name ?? t('e2ee.team.member')}
                    </span>
                    <Button
                      data-testid="e2ee-member-promote"
                      data-membership-id={member.membershipId}
                      variant="secondary"
                      size="small"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await runtime.setMemberRole!(workspaceId, member.membershipId, 'admin');
                          if (current()) setMessage(t('e2ee.team.promoted'));
                        })
                      }
                    >
                      {t('e2ee.team.promote')}
                    </Button>
                  </div>
                ))}
            </div>
          )}
        <div {...stylex.props(styles.section)}>
          <h3 {...stylex.props(styles.sectionHeading)}>{t('e2ee.team.activeInvitations')}</h3>
          {data?.invitations.map((offer) => (
            <div key={offer.token} {...stylex.props(styles.listRow)}>
              <span {...stylex.props(styles.identity, styles.label)}>
                {t(
                  offer.mode === 'email' ? 'e2ee.team.emailInvitation' : 'e2ee.team.linkInvitation'
                )}{' '}
                · {formatExpiry(offer.expiresAt)}
                {offer.email && <> · {offer.email}</>}
                {offer.needsReissue && <> · {t('e2ee.team.invitationNeedsReissue')}</>}
              </span>
              <div {...stylex.props(styles.actionGroup)}>
                <Button
                  data-testid="e2ee-invitation-copy"
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onClick={() => void copyLink(offer.token, memberInvitationUrl(offer))}
                >
                  {t(copiedKey === offer.token ? 'e2ee.team.copied' : 'e2ee.team.copyLink')}
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    setLink(memberInvitationUrl(offer));
                  }}
                >
                  {t('e2ee.team.showLink')}
                </Button>
                <Button
                  variant="ghost"
                  tone="destructive"
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await runtime.revokeMemberInvitation!(workspaceId, offer.token);
                      await refresh();
                    })
                  }
                >
                  {t('e2ee.team.revoke')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card.Root>
  );
}

/** Surface verified team management state instead of silently disappearing. */
export function E2eeTeamSettingsHost(props: {
  runtime?: E2eeWorkspaceRuntime;
  workspaceId: string;
  accountId: string;
  onOpenBilling?: () => void;
  onRefreshBilling?: () => Promise<unknown>;
  labels?: ReadonlyMap<string, string>;
  profiles?: ReadonlyMap<string, { name: string | null }>;
  onMembersChanged?: () => Promise<void>;
  /** Supplied by a live verified ledger owner; replaces this host's ledger polling. */
  ledgerVersion?: string;
}) {
  return <TeamHostSession key={`${props.accountId}:${props.workspaceId}`} {...props} />;
}
type HostState =
  | { kind: 'loading'; runtime: E2eeWorkspaceRuntime }
  | { kind: 'ready'; runtime: E2eeWorkspaceRuntime; role: string; members: Member[] }
  | { kind: 'desktop-required'; runtime: E2eeWorkspaceRuntime }
  | { kind: 'hidden'; runtime: E2eeWorkspaceRuntime }
  | { kind: 'error'; runtime: E2eeWorkspaceRuntime };

function TeamHostSession({
  runtime,
  workspaceId,
  labels,
  profiles,
  onOpenBilling,
  onRefreshBilling,
  onMembersChanged,
  ledgerVersion,
}: {
  runtime?: E2eeWorkspaceRuntime;
  workspaceId: string;
  labels?: ReadonlyMap<string, string>;
  profiles?: ReadonlyMap<string, { name: string | null }>;
  onOpenBilling?: () => void;
  onRefreshBilling?: () => Promise<unknown>;
  onMembersChanged?: () => Promise<void>;
  ledgerVersion?: string;
}) {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<HostState | null>(null);
  useEffect(() => {
    if (!runtime) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latestHistory: VerifiedLedgerHistory | undefined;
    setState((prev) => (prev?.runtime === runtime ? prev : { kind: 'loading', runtime }));
    const read = async () => {
      try {
        const view = await runtime.ledgerView(workspaceId);
        const status = view.status;
        if (stopped) return;
        if (status.memberRole === 'member' || status.memberRole === 'guest') {
          latestHistory = undefined;
          setState({ kind: 'hidden', runtime });
          return;
        }
        if (
          status.deviceKind !== 'personal' ||
          status.hasDeviceCredential !== true ||
          !['owner', 'admin'].includes(status.memberRole ?? '')
        ) {
          latestHistory = undefined;
          setState({ kind: 'desktop-required', runtime });
          return;
        }
        const history = hostLedgerHistory(view, latestHistory);
        latestHistory = history;
        setState({
          kind: 'ready',
          runtime,
          role: status.memberRole!,
          members: Array.from(history.view.inspectState().members.entries()).map(
            ([membershipId, member], index) => ({
              membershipId,
              role: member.role,
              name:
                labels?.get(membershipId) ??
                profiles?.get(bytesToHex(member.userId.toBytes()))?.name ??
                t('e2ee.team.memberNumber', { number: index + 1 }),
            })
          ),
        });
      } catch {
        if (!stopped) setState({ kind: 'error', runtime });
      } finally {
        if (!stopped && ledgerVersion === undefined) timer = setTimeout(() => void read(), 10_000);
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runtime, workspaceId, labels, profiles, t, revision, ledgerVersion]);
  if (!runtime) {
    return (
      <Card.Root data-testid="e2ee-team-host-desktop-required">
        <Card.Header>
          <Card.Title>{t('e2ee.team.title')}</Card.Title>
          <Card.Description>{t('e2ee.team.desktopManageRequired')}</Card.Description>
        </Card.Header>
      </Card.Root>
    );
  }
  const active = state?.runtime === runtime ? state : { kind: 'loading' as const, runtime };
  if (active.kind === 'hidden') return null;
  if (active.kind === 'loading') {
    return (
      <Card.Root data-testid="e2ee-team-host-loading">
        <Card.Header>
          <Card.Title>{t('e2ee.team.title')}</Card.Title>
        </Card.Header>
        <span role="status" {...stylex.props(styles.busy, styles.label)}>
          <Spinner size="small" label={null} />
          {t('e2ee.team.hostLoading')}
        </span>
      </Card.Root>
    );
  }
  if (active.kind === 'error') {
    return (
      <Card.Root data-testid="e2ee-team-host-error">
        <Card.Header>
          <Card.Title>{t('e2ee.team.title')}</Card.Title>
          <Card.Description>{t('e2ee.team.hostLoadFailed')}</Card.Description>
        </Card.Header>
        <div {...stylex.props(styles.row)}>
          <Button
            data-testid="e2ee-team-host-retry"
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('e2ee.team.hostRetry')}
          </Button>
        </div>
      </Card.Root>
    );
  }
  if (active.kind === 'desktop-required') {
    return (
      <Card.Root data-testid="e2ee-team-host-desktop-required">
        <Card.Header>
          <Card.Title>{t('e2ee.team.title')}</Card.Title>
          <Card.Description>{t('e2ee.team.desktopManageRequired')}</Card.Description>
        </Card.Header>
      </Card.Root>
    );
  }
  return (
    <E2eeTeamSettings
      runtime={runtime}
      workspaceId={workspaceId}
      canPromote={active.role === 'owner'}
      members={active.members}
      onOpenBilling={onOpenBilling}
      onRefreshBilling={onRefreshBilling}
      onMembersChanged={async () => {
        setRevision((value) => value + 1);
        await onMembersChanged?.();
      }}
    />
  );
}
