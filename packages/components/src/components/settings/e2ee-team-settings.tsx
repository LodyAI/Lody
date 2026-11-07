import { seatBillingErrorKey } from './billing-errors';
import { hostLedgerHistory, bytesToHex } from '@/lib/e2ee-ledger-history';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { E2eeMemberKeyDelivery, E2eeWorkspaceRuntime } from '@lody/platform';
import type { E2eeMemberOffer, E2eeMemberReplies } from '@lody/cloud-api';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Card } from '@lody/ui/card';
import { Spinner } from '@lody/ui/spinner';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { getAppShareUrl } from '@/lib/app-location';
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
  Partial<Pick<E2eeWorkspaceRuntime, 'memberKeyDeliveries' | 'retryMemberKeyDelivery'>>;
const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: space[3] },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  identity: { flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' },
  label: { fontSize: text.subheadlineSize, color: colors.secondaryLabel },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingBlock: space[3],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  busy: { display: 'inline-flex', alignItems: 'center', gap: space[2] },
  code: {
    fontFamily: 'monospace',
    overflowWrap: 'anywhere',
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
  },
});
export const memberInvitationUrl = (offer: E2eeMemberOffer) =>
  getAppShareUrl(`/join/${offer.token}#e2ee=${encodeURIComponent(JSON.stringify(offer))}`);

type Member = { membershipId: string; role: string; name?: string };
export function E2eeTeamSettings(props: {
  runtime: Runtime;
  workspaceId: string;
  canPromote?: boolean;
  members?: Member[];
  onOpenBilling?: () => void;
  onRefreshBilling?: () => Promise<unknown>;
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
}: {
  runtime: Runtime;
  workspaceId: string;
  canPromote?: boolean;
  members?: Member[];
  onOpenBilling?: () => void;
  onRefreshBilling?: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<E2eeMemberReplies['pending'] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<E2eeMemberKeyDelivery[]>([]);
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
    };
  }, []);
  const remember = (value: E2eeMemberReplies['pending']) => {
    for (const item of value.items)
      applicants.current.set(
        item.requestId,
        item.applicantName || item.applicantEmail || t('e2ee.team.applicant')
      );
  };
  const readDeliveries = async () => {
    if (!runtime.memberKeyDeliveries) return;
    const value = await runtime.memberKeyDeliveries(workspaceId);
    if (current()) setDeliveries(value.items);
  };
  const refresh = async () => {
    const value = await runtime.memberJoinRequests!(workspaceId);
    remember(value);
    if (current()) setData(value);
    await readDeliveries().catch(() => {});
  };
  const perform = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      if (current()) setMessage(t(seatBillingErrorKey(error) ?? 'e2ee.team.retryOriginal'));
    } finally {
      working.current = false;
      if (current()) setBusy(false);
    }
  };
  useEffect(() => {
    if (!runtime.memberJoinRequests) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const value = await runtime.memberJoinRequests!(workspaceId);
        remember(value);
        if (!disposed) setData(value);
      } catch {
        if (!disposed) setMessage(t('e2ee.team.loadFailed'));
      }
      try {
        const value = await runtime.memberKeyDeliveries?.(workspaceId);
        if (!disposed && value) setDeliveries(value.items);
      } catch {
        /* Delivery state is advisory; the request list keeps its own failure message. */
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 10_000);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [runtime, workspaceId, t]);
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
        setLink(memberInvitationUrl(offer));
        setMessage(t(mode === 'email' ? 'e2ee.team.emailSent' : 'e2ee.team.linkReady'));
      }
      await refresh();
    });
  return (
    <Card.Root data-testid="e2ee-team-settings">
      <Card.Header>
        <Card.Title>{t('e2ee.team.title')}</Card.Title>
        <Card.Description>{t('e2ee.team.help')}</Card.Description>
      </Card.Header>
      <div {...stylex.props(styles.stack)}>
        {message && <p role="status">{message}</p>}
        <SeatCostNotice preview={data?.seatPreview} />
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
        <form
          {...stylex.props(styles.row)}
          onSubmit={(event) => {
            event.preventDefault();
            void create('email');
          }}
        >
          <Input
            type="email"
            required
            aria-label={t('e2ee.team.email')}
            placeholder={t('e2ee.team.email')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />
          <Button
            variant={isSeatAdmissionReady(data?.seatPreview) ? 'primary' : 'secondary'}
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
            disabled={busy || !data}
            onClick={() => void create('link')}
          >
            {t('e2ee.team.createLink')}
          </Button>
          <span {...stylex.props(styles.label)}>{t('e2ee.team.linkHelp')}</span>
        </div>
        {link && (
          <Input
            data-testid="e2ee-invitation-link"
            aria-label={t('e2ee.team.invitationLink')}
            readOnly
            value={link}
            onFocus={(event) => event.target.select()}
          />
        )}
        <h3>{t('e2ee.team.requests')}</h3>
        {data?.items.length === 0 && (
          <p {...stylex.props(styles.label)}>{t('e2ee.team.noRequests')}</p>
        )}
        {data?.items.map((request) => (
          <div
            data-testid="e2ee-join-request"
            data-request-id={request.requestId}
            key={request.requestId}
            {...stylex.props(styles.item)}
          >
            <div {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.identity)}>
                {request.applicantName || request.applicantEmail || t('e2ee.team.applicant')}
              </span>
              <span {...stylex.props(styles.label)}>
                {t(
                  request.source === 'email' ? 'e2ee.team.automatic' : 'e2ee.team.approvalRequired'
                )}
              </span>
            </div>
            {request.applicantEmail && (
              <span {...stylex.props(styles.label)}>{request.applicantEmail}</span>
            )}
            <details>
              <summary>{t('e2ee.team.deviceKey')}</summary>
              <code {...stylex.props(styles.code)}>{request.signingPublicKey}</code>
            </details>
            <div {...stylex.props(styles.row)}>
              <Button
                data-testid="e2ee-join-approve"
                data-request-id={request.requestId}
                disabled={
                  busy || (request.state === 'pending' && !isSeatAdmissionReady(data?.seatPreview))
                }
                aria-busy={approving === request.requestId || undefined}
                onClick={() =>
                  void perform(async () => {
                    if (request.state === 'pending' && !isSeatAdmissionReady(data?.seatPreview))
                      return;
                    setApproving(request.requestId);
                    try {
                      const result = await runtime.approveMemberJoin!(
                        workspaceId,
                        request.requestId,
                        'explicit'
                      );
                      if (current())
                        setMessage(
                          t(result.admitted ? 'e2ee.team.admitted' : 'e2ee.team.reconciling')
                        );
                    } finally {
                      if (current()) setApproving(null);
                    }
                    await refresh();
                  })
                }
              >
                {approving === request.requestId ? (
                  <span {...stylex.props(styles.busy)}>
                    <Spinner size="small" label={null} />
                    {t('e2ee.team.submitting')}
                  </span>
                ) : (
                  t(
                    request.source === 'email' ? 'e2ee.team.continueAdmission' : 'e2ee.team.approve'
                  )
                )}
              </Button>
              {request.state === 'pending' && (
                <Button
                  variant="secondary"
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
        {data?.hasMore && <p>{t('e2ee.team.moreRequests')}</p>}
        {deliveries
          .filter((delivery) => delivery.state !== 'delivered')
          .map((delivery) => (
            <div
              data-testid="e2ee-key-delivery"
              data-key-delivery-id={delivery.requestId}
              key={delivery.requestId}
              {...stylex.props(styles.row)}
            >
              <span {...stylex.props(styles.identity)}>
                {applicants.current.get(delivery.requestId) ?? t('e2ee.team.applicant')}
              </span>
              {delivery.state === 'failed' ? (
                <>
                  <span role="status" {...stylex.props(styles.label)}>
                    {t('e2ee.team.keyFailed')}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void (async () => {
                        try {
                          const next = await runtime.retryMemberKeyDelivery?.(
                            workspaceId,
                            delivery.requestId
                          );
                          if (next && current())
                            setDeliveries((items) =>
                              items.map((item) => (item.requestId === next.requestId ? next : item))
                            );
                        } catch {
                          /* The next poll shows the retained failure again. */
                        }
                      })()
                    }
                  >
                    {t('e2ee.team.keyRetry')}
                  </Button>
                </>
              ) : (
                <span role="status" {...stylex.props(styles.busy, styles.label)}>
                  <Spinner size="small" label={null} />
                  {t('e2ee.team.keySending')}
                </span>
              )}
            </div>
          ))}
        {canPromote &&
          runtime.setMemberRole &&
          members?.some((member) => member.role === 'member') && (
            <div {...stylex.props(styles.stack)}>
              <h3>{t('e2ee.team.admins')}</h3>
              {members
                .filter((member) => member.role === 'member')
                .map((member) => (
                  <div key={member.membershipId} {...stylex.props(styles.row)}>
                    <span {...stylex.props(styles.identity)}>
                      {member.name ?? t('e2ee.team.member')}
                    </span>
                    <Button
                      data-testid="e2ee-member-promote"
                      data-membership-id={member.membershipId}
                      variant="secondary"
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
        <h3>{t('e2ee.team.activeInvitations')}</h3>
        {data?.invitations.map((offer) => (
          <div key={offer.token} {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.identity, styles.label)}>
              {t(offer.mode === 'email' ? 'e2ee.team.emailInvitation' : 'e2ee.team.linkInvitation')}{' '}
              · {new Date(offer.expiresAt).toLocaleString()}
            </span>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setLink(memberInvitationUrl(offer));
              }}
            >
              {t('e2ee.team.showLink')}
            </Button>
            <Button
              variant="secondary"
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
        ))}
      </div>
    </Card.Root>
  );
}

/** Hide management until the native host verifies this personal device's current role. */
export function E2eeTeamSettingsHost(props: {
  runtime: E2eeWorkspaceRuntime;
  workspaceId: string;
  accountId: string;
  onOpenBilling?: () => void;
  onRefreshBilling?: () => Promise<unknown>;
  labels?: ReadonlyMap<string, string>;
  profiles?: ReadonlyMap<string, { name: string | null }>;
}) {
  return <TeamHostSession key={`${props.accountId}:${props.workspaceId}`} {...props} />;
}
function TeamHostSession({
  runtime,
  workspaceId,
  labels,
  profiles,
  onOpenBilling,
  onRefreshBilling,
}: {
  runtime: E2eeWorkspaceRuntime;
  workspaceId: string;
  labels?: ReadonlyMap<string, string>;
  profiles?: ReadonlyMap<string, { name: string | null }>;
  onOpenBilling?: () => void;
  onRefreshBilling?: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<{
    runtime: E2eeWorkspaceRuntime;
    role: string;
    members: Member[];
  } | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const view = await runtime.ledgerView(workspaceId);
        const status = view.status;
        if (stopped) return;
        if (
          status.deviceKind !== 'personal' ||
          status.hasDeviceCredential !== true ||
          !['owner', 'admin'].includes(status.memberRole ?? '')
        ) {
          setState(null);
          return;
        }
        const history = hostLedgerHistory(view);
        setState({
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
        if (!stopped) setState(null);
      } finally {
        if (!stopped) timer = setTimeout(() => void read(), 10_000);
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runtime, workspaceId, labels, profiles, t]);
  return state?.runtime === runtime ? (
    <E2eeTeamSettings
      runtime={runtime}
      workspaceId={workspaceId}
      canPromote={state.role === 'owner'}
      members={state.members}
      onOpenBilling={onOpenBilling}
      onRefreshBilling={onRefreshBilling}
    />
  ) : null;
}
