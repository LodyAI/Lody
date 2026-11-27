// @vitest-environment jsdom
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Result } from 'effect';
import { exportVerifiedState } from '@lody/e2ee-core/protocol';
import { appendLedgerHistory, bytesToHex } from '../src/lib/e2ee-ledger-history';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2eeMemberOffer, E2eeMemberReplies } from '@lody/cloud-api';
import { SeatInvitePreviewSchema } from '@lody/cloud-api/seat-invite-preview';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { E2eeMemberJoin } from '../src/components/pages/e2ee-member-join';
import {
  E2eeTeamSettings,
  E2eeTeamSettingsHost,
  memberInvitationUrl,
} from '../src/components/settings/e2ee-team-settings';
import {
  desktopMemberJoinLink,
  memberJoinPath,
  parseMemberOffer,
  sameMemberOffer,
} from '../src/lib/e2ee-member-offer';
import { resolveDesktopInviteDeepLinkPath } from '../src/lib/desktop-invite-deep-link';
vi.mock('react-i18next', () => {
  const t = (key: string, params?: { code?: string }) =>
    params?.code ? `${key}:${params.code}` : key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('../src/components/settings/invite-member-dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/settings/invite-member-dialog')>()),
  SeatCostNotice: ({ preview }: { preview: unknown }) => (
    <p>{preview ? 'seat quote' : 'quote loading'}</p>
  ),
}));
const offer: E2eeMemberOffer = {
  version: 1,
  workspaceId: 'team',
  genesisHash: '11'.repeat(32),
  genesisRecordHex: 'abcd',
  endorser: '22'.repeat(32),
  token: '33'.repeat(32),
  mode: 'link',
  expiresAt: 2000,
};
const application = (
  id: string,
  source: 'email' | 'link'
): E2eeMemberReplies['pending']['items'][number] => ({
  id,
  workspaceId: 'team',
  accountId: id,
  keyPackageHex: 'abcd',
  signingPublicKey: '44'.repeat(32),
  requestId: id,
  source,
  state: 'pending',
  expiresAt: 2000,
  offer,
  applicantName: id,
  applicantEmail: `${id}@synthetic.test`,
});
const empty: E2eeMemberReplies['pending'] = {
  items: [],
  invitations: [],
  hasMore: false,
  seatPreview: { status: 'not_billed', reason: 'free' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });
const status = { deviceKind: 'personal', memberRole: 'admin' } as Awaited<
  ReturnType<E2eeWorkspaceRuntime['status']>
>;
describe('encrypted team joining', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  const render = async (node: React.ReactNode) => {
    await act(async () => root.render(node));
  };
  const button = (key: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === key)!;
  it('rechecks an approval hint immediately and waits for the verified key before opening', async () => {
    const { PlatformContext } = await import('@lody/platform/react');
    const { TEST_CLOUD_PLATFORM } = await import('./test-platform');
    let hint: ReturnType<typeof application> | undefined;
    let state = 'pending';
    let ready = false;
    const platform = {
      ...TEST_CLOUD_PLATFORM,
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useQueryState: <Args, Value>(operation: { name: string }, args: Args | 'skip') => ({
          data: (operation.name === 'e2eeMembers:claim' && args !== 'skip' ? hint : undefined) as
            | Value
            | undefined,
          error: null,
          retry: () => {},
        }),
      },
    };
    const props = {
      offer,
      runtime: {
        pendingMemberJoin: async () => ({ offer, requestId: 'original' }),
        prepareMemberJoin: async () => {
          throw new Error('The saved request should be resumed');
        },
        claimMemberJoin: async () => ({ state, ready }),
      },
      accountId: 'account',
      emailVerified: true,
      watchClaim: true,
      onSignInRequested: () => {},
      onEmailVerificationRequested: () => {},
      onWorkspaceRequested: () => {},
      onHomeRequested: () => {},
    };
    const showJoin = () =>
      render(
        <PlatformContext.Provider value={platform}>
          <E2eeMemberJoin {...props} />
        </PlatformContext.Provider>
      );
    await showJoin();
    expect(container.textContent).toContain('e2ee.team.waitingApproval');
    state = 'committed';
    hint = { ...application('original', 'link'), state: 'committed' };
    await showJoin();
    expect(container.textContent).toContain('e2ee.team.waitingKey');
    expect(button('e2ee.team.openWorkspace')).toBeUndefined();
    ready = true;
    await act(async () => vi.advanceTimersByTime(500));
    expect(button('e2ee.team.openWorkspace')).toBeDefined();
  });

  it('recovers the saved original after expiry and separates membership from key readiness', async () => {
    let installed = false;
    let unexpectedSubmission = false;
    const runtime = {
      pendingMemberJoin: async () => ({ offer, requestId: 'original' }),
      prepareMemberJoin: async () => {
        unexpectedSubmission = true;
        throw new Error('must not replace saved request');
      },
      claimMemberJoin: async () => {
        claims++;
        return { state: 'committed', ready: installed };
      },
    };
    let claims = 0;
    vi.setSystemTime(3000);
    const props = {
      offer,
      runtime,
      accountId: 'account',
      email: 'a@synthetic.test',
      emailVerified: true,
      preview: { status: 'unavailable' as const },
      onSignInRequested: () => {},
      onEmailVerificationRequested: () => {},
      onWorkspaceRequested: () => {},
      onHomeRequested: () => {},
    };
    await render(<E2eeMemberJoin {...props} />);
    await settle();
    expect(container.textContent).toContain('e2ee.team.waitingKey');
    // Membership is approved; the one card now waits on key delivery.
    expect(container.querySelector('[aria-current="step"]')?.getAttribute('data-join-step')).toBe(
      'key'
    );
    // Key delivery needs an administrator device; the joining member is told so.
    expect(container.textContent).toContain('e2ee.team.waitingKeyGuide');
    expect(button('e2ee.team.submit')).toBeUndefined();
    // Once approved, the first key recheck starts at 500 ms and backs off.
    expect(claims).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(claims).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(claims).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(claims).toBe(3);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(claims).toBe(4);
    // The fast cadence is bounded; after two minutes it returns to 10 s.
    await act(async () => vi.advanceTimersByTimeAsync(120_500 - 3500));
    const slow = claims;
    await act(async () => vi.advanceTimersByTimeAsync(9999));
    expect(claims).toBe(slow);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(claims).toBe(slow + 1);
    // After the fast window the member is told why it is still waiting, and can retry.
    expect(container.textContent).toContain('e2ee.team.waitingKeySlow');
    await act(async () => button('e2ee.team.checkKeyAgain').click());
    await settle();
    expect(unexpectedSubmission).toBe(false);
    expect(claims).toBe(slow + 2);
    expect(container.textContent).not.toContain('e2ee.team.waitingKeySlow');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(claims).toBe(slow + 3);
    installed = true;
    await act(async () => window.dispatchEvent(new Event('online')));
    await settle();
    expect(container.textContent).toContain('e2ee.team.ready');
    expect(button('e2ee.team.openWorkspace')).toBeDefined();
  });
  it.each([
    ['confirmed', true],
    ['still waiting for its key', false],
  ] as const)(
    'shows a reopened join the host reports as joined at once, then follows its one claim (%s)',
    async (_label, installed) => {
      let claims = 0;
      let answer!: (result: { state: string; ready: boolean }) => void;
      const runtime = {
        pendingMemberJoin: async () => ({ offer, requestId: 'original', joined: true }),
        prepareMemberJoin: async () => {
          throw new Error('must not submit another request');
        },
        claimMemberJoin: () => {
          claims++;
          return new Promise<{ state: string; ready: boolean }>((resolve) => {
            answer = resolve;
          });
        },
      };
      await render(
        <E2eeMemberJoin
          offer={offer}
          runtime={runtime}
          accountId="account"
          emailVerified
          preview={{ status: 'unavailable' }}
          onSignInRequested={() => {}}
          onEmailVerificationRequested={() => {}}
          onWorkspaceRequested={() => {}}
          onHomeRequested={() => {}}
        />
      );
      await settle();
      // Joined before the confirming claim answers: no approval wait, no new request.
      expect(container.textContent).toContain('e2ee.team.ready');
      expect(container.textContent).not.toContain('e2ee.team.waitingApproval');
      expect(button('e2ee.team.openWorkspace')).toBeDefined();
      expect(button('e2ee.team.submit')).toBeUndefined();
      expect(claims).toBe(1);
      await act(async () => answer({ state: 'committed', ready: installed }));
      await settle();
      if (installed) {
        expect(container.textContent).toContain('e2ee.team.ready');
        await act(async () => vi.advanceTimersByTime(30_000));
        await settle();
        expect(claims).toBe(1);
      } else {
        // The claim's answer replaces the hint: the page waits for the key as usual.
        expect(container.textContent).toContain('e2ee.team.waitingKey');
        expect(button('e2ee.team.openWorkspace')).toBeUndefined();
      }
    }
  );
  it('shows saved request progress after a lost submit response without another consent request', async () => {
    let saved = false;
    const runtime = {
      pendingMemberJoin: async () => (saved ? { offer, requestId: 'original' } : null),
      prepareMemberJoin: async () => {
        saved = true;
        throw new Error('lost acknowledgement');
      },
      claimMemberJoin: async () => ({ state: 'pending', ready: false }),
    };
    await render(
      <E2eeMemberJoin
        offer={offer}
        runtime={runtime}
        accountId="account"
        emailVerified
        preview={{
          status: 'available',
          offer,
          workspaceName: 'Team',
          workspaceSlug: 'team',
          recipientEmailMasked: null,
          matchesRecipient: null,
        }}
        onSignInRequested={() => {}}
        onEmailVerificationRequested={() => {}}
        onWorkspaceRequested={() => {}}
        onHomeRequested={() => {}}
      />
    );
    await act(async () => button('e2ee.team.submit').click());
    await settle();
    expect(saved).toBe(true);
    expect(container.textContent).toContain('e2ee.team.waitingApproval');
    expect(container.querySelector('[aria-current="step"]')?.getAttribute('data-join-step')).toBe(
      'approval'
    );
    expect(button('e2ee.team.submit')).toBeUndefined();
  });
  it.each(['method_required', 'payment_required', 'refresh'] as const)(
    'blocks encrypted approval for %s and resumes after payment recovery refresh',
    async (paymentAction) => {
      let ready = false,
        admitted = false,
        billingOpened = false;
      const refreshed = deferred<void>();
      const seatPreview = () =>
        SeatInvitePreviewSchema.parse({
          status: 'billed',
          interval: 'month',
          unitAmount: 1000,
          proratedAmount: 500,
          currentPeriodEnd: null,
          seatCount: 1,
          nextSeatCount: 2,
          nextRenewalAmount: 2000,
          paymentAction: ready ? undefined : paymentAction,
          addedSeats: 1,
          invoiceAt: null,
        });
      await render(
        <E2eeTeamSettings
          workspaceId="team"
          runtime={{
            createMemberInvitation: async () => offer,
            memberJoinRequests: async () => ({
              ...empty,
              seatPreview: seatPreview(),
              items: admitted ? [] : [application('applicant', 'link')],
            }),
            approveMemberJoin: async () => {
              admitted = true;
              return { admitted: true, keyPending: false };
            },
            rejectMemberJoin: async () => ({ state: 'rejected' }),
            revokeMemberInvitation: async () => ({ revoked: true }),
          }}
          onOpenBilling={() => {
            billingOpened = true;
          }}
          onRefreshBilling={async () => {
            await refreshed.promise;
            ready = true;
          }}
        />
      );
      await settle();
      expect(
        container.querySelector<HTMLButtonElement>('[data-testid="e2ee-join-approve"]')?.disabled
      ).toBe(true);
      expect(admitted).toBe(false);
      if (paymentAction !== 'refresh') {
        await act(async () =>
          button(
            paymentAction === 'method_required'
              ? 'billing.seatResolveMethod'
              : 'billing.seatResolvePayment'
          ).click()
        );
        expect(billingOpened).toBe(true);
      }
      const refresh = button('billing.seatRefreshPayment');
      expect(refresh).toBeDefined();
      await act(async () => refresh.click());
      expect(
        container.querySelector<HTMLButtonElement>('[data-testid="e2ee-join-approve"]')?.disabled
      ).toBe(true);
      await act(async () => refreshed.resolve());
      await settle();
      expect(button('billing.seatRefreshPayment')).toBeUndefined();
      const approve = container.querySelector<HTMLButtonElement>(
        '[data-testid="e2ee-join-approve"]'
      )!;
      expect(approve.disabled).toBe(false);
      await act(async () => approve.click());
      expect(admitted).toBe(true);
      expect(container.querySelector('[data-testid="e2ee-join-approve"]')).toBeNull();
    }
  );

  it.each(['method_required', 'payment_required'] as const)(
    'explains native-shell %s without adding a payment destination',
    async (paymentAction) => {
      await render(
        <E2eeTeamSettings
          workspaceId="team"
          runtime={{
            createMemberInvitation: async () => offer,
            memberJoinRequests: async () => ({
              ...empty,
              items: [application('applicant', 'link')],
              seatPreview: SeatInvitePreviewSchema.parse({
                status: 'billed',
                interval: 'month',
                unitAmount: 1000,
                proratedAmount: 500,
                currentPeriodEnd: null,
                seatCount: 1,
                nextSeatCount: 2,
                nextRenewalAmount: 2000,
                paymentAction,
              }),
            }),
            approveMemberJoin: async () => {
              throw new Error('payment must be resolved first');
            },
            rejectMemberJoin: async () => ({ state: 'rejected' }),
            revokeMemberInvitation: async () => ({ revoked: true }),
          }}
          onRefreshBilling={async () => {}}
        />
      );
      await settle();
      expect(
        container.querySelector<HTMLButtonElement>('[data-testid="e2ee-join-approve"]')?.disabled
      ).toBe(true);
      expect(container.textContent).toContain('billing.seatResolveOnWeb');
      expect(button('billing.seatRefreshPayment')).toBeDefined();
      expect(button('billing.seatResolveMethod')).toBeUndefined();
      expect(button('billing.seatResolvePayment')).toBeUndefined();
      expect(container.querySelector('a[href*="billing"]')).toBeNull();
    }
  );

  it('states the added seat cost beside approve when the workspace is billed', async () => {
    await render(
      <E2eeTeamSettings
        workspaceId="team"
        runtime={{
          createMemberInvitation: async () => offer,
          memberJoinRequests: async () => ({
            ...empty,
            items: [application('applicant', 'link')],
            seatPreview: {
              status: 'billed',
              interval: 'month',
              unitAmount: 1000,
              proratedAmount: 973,
              currentPeriodEnd: null,
              seatCount: 2,
              nextSeatCount: 3,
              nextRenewalAmount: 3000,
            },
          }),
          approveMemberJoin: async () => ({ admitted: true, keyPending: false }),
          memberKeyDeliveries: async () => ({ items: [] }),
          retryMemberKeyDelivery: async () => ({ requestId: 'applicant', state: 'pending' }),
          rejectMemberJoin: async () => ({ state: 'rejected' }),
          revokeMemberInvitation: async () => ({ revoked: true }),
        }}
      />
    );
    await settle();
    const cost = container.querySelector('[data-testid="e2ee-join-approve-cost"]');
    expect(cost?.textContent).toBe('e2ee.team.approveCost');
  });
  it('requires explicit manual approval for both email and link join requests and keeps invitation warnings', async () => {
    const emailOffer = { ...offer, mode: 'email' as const };
    const approvals: Array<[string, string, 'automatic' | 'explicit']> = [];
    let created: Promise<unknown> = Promise.resolve();
    await render(
      <E2eeTeamSettings
        workspaceId="refused-team"
        runtime={{
          createMemberInvitation: async () => {
            created = Promise.reject(
              new Error(
                "Error invoking remote method 'e2ee:createMemberInvitation': Error: e2ee_member_invitation_request_pending"
              )
            );
            return created as never;
          },
          memberJoinRequests: async () => ({
            ...empty,
            items: [application('email-req', 'email'), application('link-req', 'link')],
            invitations: [
              { ...offer, mode: 'email', needsReissue: true, email: 'legacy@synthetic.test' },
            ],
          }),
          approveMemberJoin: async (workspace, id, mode) => {
            approvals.push([workspace, id, mode]);
            return { admitted: true, keyPending: true };
          },
          rejectMemberJoin: async () => ({ state: 'rejected' }),
          revokeMemberInvitation: async () => ({ revoked: true }),
        }}
      />
    );
    await settle();
    const mode = (id: string) =>
      container.querySelector(`[data-request-id="${id}"] [data-testid="e2ee-join-admission-mode"]`)
        ?.textContent;
    const action = (id: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-testid="e2ee-join-approve"][data-request-id="${id}"]`
      )!;
    expect(mode('email-req')).toBe('e2ee.team.approvalRequired');
    expect(mode('link-req')).toBe('e2ee.team.approvalRequired');
    expect(action('email-req').textContent).toBe('e2ee.team.approve');
    expect(action('link-req').textContent).toBe('e2ee.team.approve');
    // Unsigned email invitation shows its address, is marked for re-sending and stays revocable.
    expect(container.textContent).toContain('legacy@synthetic.test');
    expect(container.textContent).toContain('e2ee.team.invitationNeedsReissue');
    expect(button('e2ee.team.revoke')).toBeTruthy();
    // Clicking approve on the email request sends explicit mode.
    await act(async () => action('email-req').click());
    await settle();
    expect(approvals).toEqual([['refused-team', 'email-req', 'explicit']]);
    // Inviting while that email's earlier applicant is still waiting says what to do.
    const input = container.querySelector('input[type="email"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'legacy@synthetic.test'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('e2ee.team.invite').click());
    await settle();
    await created.catch(() => {});
    expect(container.textContent).toContain('e2ee.team.invitationRequestPending');
    // Invitee waiting on an email invitation sees the explicit approval wait copy.
    await render(
      <E2eeMemberJoin
        offer={emailOffer}
        runtime={{
          pendingMemberJoin: async () => ({ offer: emailOffer, requestId: 'email-req' }),
          prepareMemberJoin: async () => ({
            offer: emailOffer,
            requestId: 'email-req',
            state: 'pending',
          }),
          claimMemberJoin: async () => ({ state: 'pending', ready: false }),
        }}
        accountId="account"
        emailVerified
        preview={{ status: 'unavailable' }}
        onSignInRequested={() => {}}
        onEmailVerificationRequested={() => {}}
        onWorkspaceRequested={() => {}}
        onHomeRequested={() => {}}
      />
    );
    await settle();
    expect(container.textContent).toContain('e2ee.team.waitingApproval');
    expect(container.textContent).not.toContain('e2ee.team.waitingAdminDevice');
  });
  it('says a full free workspace cannot admit more members instead of signing a refused approval', async () => {
    const approved: string[] = [];
    // The list knew: approve stays off and the row says why.
    let full = true;
    const runtime = {
      createMemberInvitation: async () => offer,
      memberJoinRequests: async () => ({
        ...empty,
        items: [{ ...application('applicant', 'link'), memberLimitReached: full }],
      }),
      approveMemberJoin: async (_workspace: string, id: string) => {
        approved.push(id);
        // The workspace filled after the list was read: the relay refuses the admission.
        full = true;
        throw new Error('e2ee_runtime_failed');
      },
      memberKeyDeliveries: async () => ({ items: [] }),
      retryMemberKeyDelivery: async () => ({ requestId: 'applicant', state: 'pending' as const }),
      rejectMemberJoin: async () => ({ state: 'rejected' as const }),
      revokeMemberInvitation: async () => ({ revoked: true as const }),
    };
    await render(<E2eeTeamSettings workspaceId="team" runtime={runtime} />);
    await settle();
    expect(container.querySelector('[data-testid="e2ee-join-member-limit"]')?.textContent).toBe(
      'e2ee.team.memberLimit'
    );
    const approve = container.querySelector<HTMLButtonElement>(
      '[data-testid="e2ee-join-approve"]'
    )!;
    expect(approve.disabled).toBe(true);

    full = false;
    await render(<E2eeTeamSettings key="later" workspaceId="team" runtime={runtime} />);
    await settle();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="e2ee-join-approve"]')!.click()
    );
    await settle();
    await settle();
    expect(approved).toEqual(['applicant']);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('e2ee.team.memberLimit');
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="e2ee-join-approve"]')!.disabled
    ).toBe(true);
  });
  it('keeps a link request pending until the administrator approves the displayed request', async () => {
    const request = application('applicant', 'link');
    let state = 'pending';
    let delivery: {
      requestId: string;
      state: 'pending' | 'delivering' | 'delivered' | 'failed';
      code?: string;
    }[] = [];
    const retryResponse = deferred<'network'>();
    let retryFailed = false;
    const confirmation = deferred<{
      admitted: boolean;
      keyPending: boolean;
      keyDelivery?: 'pending' | 'delivered' | 'failed';
    }>();
    await render(
      <E2eeTeamSettings
        workspaceId="team"
        runtime={{
          createMemberInvitation: async () => offer,
          memberJoinRequests: async () => ({
            ...empty,
            items: state === 'pending' ? [request] : [],
          }),
          approveMemberJoin: async (_workspace, id, mode) => {
            expect(id).toBe(request.requestId);
            expect(mode).toBe('explicit');
            const result = await confirmation.promise;
            state = 'committed';
            return result;
          },
          memberKeyDeliveries: async () => ({ items: delivery }),
          retryMemberKeyDelivery: async (_workspace, id) => {
            if (!retryFailed) {
              const code = await retryResponse.promise;
              retryFailed = true;
              throw Object.assign(new Error('Connection interrupted'), { code });
            }
            delivery = [{ requestId: id, state: 'pending' }];
            return delivery[0]!;
          },
          rejectMemberJoin: async () => ({ state: 'rejected' }),
          revokeMemberInvitation: async () => ({ revoked: true }),
        }}
      />
    );
    expect(container.textContent).toContain('seat quote');
    expect(state).toBe('pending');
    await act(async () => button('e2ee.team.approve').click());
    expect(state).toBe('pending');
    // The submitting admin sees progress on the request itself, not a silent disabled card.
    const submitting = button('e2ee.team.submitting');
    expect(submitting.disabled).toBe(true);
    expect(submitting.getAttribute('aria-busy')).toBe('true');
    delivery = [{ requestId: request.requestId, state: 'pending' }];
    confirmation.resolve({ admitted: true, keyPending: true, keyDelivery: 'pending' });
    await settle();
    expect(state).toBe('committed');
    expect(container.textContent).toContain('e2ee.team.admitted');
    expect(container.textContent).toContain('e2ee.team.noRequests');
    // Admission and key delivery are separate: the admitted applicant stays visible.
    const row = () => container.querySelector(`[data-key-delivery-id="${request.requestId}"]`);
    expect(row()?.textContent).toContain(request.applicantName);
    expect(row()?.textContent).toContain('e2ee.team.keySending');
    // A round in flight is still shown as sending.
    delivery = [{ requestId: request.requestId, state: 'delivering' }];
    await act(async () => vi.advanceTimersByTime(10_000));
    await settle();
    expect(row()?.textContent).toContain('e2ee.team.keySending');
    delivery = [{ requestId: request.requestId, state: 'failed', code: 'e2ee_management_retry' }];
    await act(async () => vi.advanceTimersByTime(10_000));
    await settle();
    expect(row()?.textContent).toContain('e2ee.team.keyFailed');
    await act(async () => button('e2ee.team.keyRetry').click());
    expect(button('e2ee.team.keyRetry').disabled).toBe(true);
    expect(row()?.textContent).toContain('e2ee.team.keyRetrying');
    await act(async () => retryResponse.resolve('network'));
    expect(row()?.textContent).toContain('e2ee.team.keyRetryError.network');
    expect(button('e2ee.team.keyRetry').disabled).toBe(false);
    await act(async () => button('e2ee.team.keyRetry').click());
    expect(row()?.textContent).toContain('e2ee.team.keySending');
    delivery = [{ requestId: request.requestId, state: 'delivered' }];
    await act(async () => vi.advanceTimersByTime(10_000));
    await settle();
    expect(row()).toBeNull();
  });
  it('clears a recovered delivery row promptly after manual retry succeeds without waiting 10s', async () => {
    const recoveredId = 'recovered-member-1';
    let deliveries: {
      requestId: string;
      state: 'pending' | 'delivering' | 'delivered' | 'failed';
      code?: string;
    }[] = [{ requestId: recoveredId, state: 'failed', code: 'e2ee_key_not_sent' }];
    await render(
      <E2eeTeamSettings
        workspaceId="team"
        runtime={{
          createMemberInvitation: async () => offer,
          memberJoinRequests: async () => empty,
          approveMemberJoin: async () => ({ admitted: true, keyPending: false }),
          memberKeyDeliveries: async () => ({ items: deliveries }),
          retryMemberKeyDelivery: async (_workspace, id) => {
            deliveries = [{ requestId: id, state: 'delivered' }];
            return { requestId: id, state: 'delivering' as const };
          },
          rejectMemberJoin: async () => ({ state: 'rejected' }),
          revokeMemberInvitation: async () => ({ revoked: true }),
        }}
      />
    );
    const row = () => container.querySelector(`[data-key-delivery-id="${recoveredId}"]`);
    expect(row()?.textContent).toContain('e2ee.team.keyFailed');
    await act(async () => button('e2ee.team.keyRetry').click());
    expect(row()?.textContent).toContain('e2ee.team.keySending');
    await act(async () => vi.advanceTimersByTime(500));
    await settle();
    expect(row()).toBeNull();
  });
  it('uses the shared member-role command and reports success only after it completes', async () => {
    let role: 'member' | 'admin' = 'member';
    const accepted = deferred<void>();
    await render(
      <E2eeTeamSettings
        workspaceId="team"
        canPromote
        members={[{ membershipId: '55'.repeat(16), role, name: 'Riley' }]}
        runtime={{
          createMemberInvitation: async () => offer,
          memberJoinRequests: async () => empty,
          approveMemberJoin: async () => ({ admitted: true, keyPending: false }),
          rejectMemberJoin: async () => ({ state: 'rejected' }),
          revokeMemberInvitation: async () => ({ revoked: true }),
          setMemberRole: async (workspaceId, membershipId, nextRole) => {
            expect([workspaceId, membershipId, nextRole]).toEqual([
              'team',
              '55'.repeat(16),
              'admin',
            ]);
            await accepted.promise;
            role = nextRole;
          },
        }}
      />
    );
    await act(async () => button('e2ee.team.promote').click());
    expect(role).toBe('member');
    expect(button('e2ee.team.promote').disabled).toBe(true);
    expect(container.textContent).not.toContain('e2ee.team.promoted');
    accepted.resolve();
    await settle();
    expect(role).toBe('admin');
    expect(container.textContent).toContain('e2ee.team.promoted');
  });
  it.each([
    ['personal', 'owner', true, true],
    ['personal', 'admin', true, true],
    ['personal', 'member', true, false],
    ['personal', 'guest', true, false],
    ['recovery', 'owner', true, false],
    ['machine', 'owner', true, false],
    ['personal', 'owner', false, false],
  ] as const)(
    'uses verified personal management facts without a local agent: %s / %s / credential %s',
    async (deviceKind, memberRole, hasDeviceCredential, allowed) => {
      const vector = JSON.parse(
        readFileSync(
          join(import.meta.dirname, '../../e2ee-core/test/ledger-v1-vector.json'),
          'utf8'
        )
      ) as { anchor: string; records: { hex: string; hash: string }[] };
      const history = appendLedgerHistory(
        null,
        {
          workspaceId: 'team',
          genesisHash: vector.anchor,
          checkpoint: { length: 1, headHash: vector.anchor },
          startIndex: 0,
          nextCursor: null,
          recordsHex: [vector.records[0]!.hex],
        },
        { workspaceId: 'team', genesisHash: vector.anchor, localPin: vector.anchor }
      );
      const snapshot = Result.getOrThrow(exportVerifiedState(history.view));
      const ledger = {
        stateHex: bytesToHex(snapshot.bytes),
        recordsHex: [vector.records[0]!.hex],
        status: {
          workspaceId: 'team',
          genesisHash: vector.anchor,
          length: 1,
          headHash: vector.anchor,
          stateDigest: bytesToHex(snapshot.stateDigest.toBytes()),
          epoch: 0,
          rotationRequired: false,
          deviceKind,
          memberRole,
          hasDeviceCredential,
          hasCurrentKey: true,
          continuityPending: false,
        },
      };
      const invitations: unknown[] = [];
      const runtime = {
        ledgerView: async () => ledger,
        createMemberInvitation: async (input: unknown) => {
          invitations.push(input);
          return offer;
        },
        memberJoinRequests: async () => empty,
        approveMemberJoin: async () => ({ admitted: true, keyPending: false }),
        rejectMemberJoin: async () => ({ state: 'rejected' }),
        revokeMemberInvitation: async () => ({ revoked: true }),
      } as unknown as E2eeWorkspaceRuntime;
      await render(
        <E2eeTeamSettingsHost runtime={runtime} workspaceId="team" accountId="account" />
      );
      const create = () =>
        [...container.querySelectorAll('button')].find(
          (node) => node.textContent === 'e2ee.team.createLink'
        );
      if (!allowed) {
        expect(create()).toBeUndefined();
        expect(invitations).toEqual([]);
        return;
      }
      expect(create()).toBeDefined();
      await act(async () => create()!.click());
      expect(invitations).toEqual([{ workspaceId: 'team', mode: 'link' }]);
      expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toContain(
        offer.token
      );
      const pending = deferred<typeof ledger>();
      await render(
        <E2eeTeamSettingsHost
          runtime={{ ...runtime, ledgerView: () => pending.promise }}
          workspaceId="team"
          accountId="account"
        />
      );
      expect(create()).toBeUndefined();
      pending.resolve({
        ...ledger,
        status: { ...ledger.status, memberRole: 'guest' },
      } as typeof ledger);
      await settle();
      expect(create()).toBeUndefined();
    }
  );
  it('matches signed pending offers with unsigned link pins in either order', () => {
    const signed = { ...offer, signature: 'aa'.repeat(64) };
    const parsed = parseMemberOffer(JSON.stringify(signed))!;
    expect(parsed).toEqual(offer);
    expect(sameMemberOffer(signed, parsed)).toBe(true);
    expect(sameMemberOffer(parsed, signed)).toBe(true);
    expect(sameMemberOffer(signed, { ...offer, signature: 'bb'.repeat(64) })).toBe(true);
  });
  it.each([
    ['version', 2],
    ['workspaceId', 'other'],
    ['genesisHash', '99'.repeat(32)],
    ['genesisRecordHex', 'cdef'],
    ['endorser', '99'.repeat(32)],
    ['token', '99'.repeat(32)],
    ['mode', 'email'],
    ['expiresAt', 3000],
  ])('rejects a different %s when matching invitation pins', (key, value) => {
    const changed = { ...offer, [key]: value } as E2eeMemberOffer;
    expect(sameMemberOffer(offer, changed)).toBe(false);
    expect(sameMemberOffer(changed, offer)).toBe(false);
  });
  it.each([2049, 8192])('accepts a %i-byte genesis through link and desktop handoff', (size) => {
    const large = {
      ...offer,
      genesisRecordHex: 'ab'.repeat(size),
      workspaceId: 'a'.repeat(128),
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    expect(parseMemberOffer(JSON.stringify(large))).toEqual(large);
    expect(resolveDesktopInviteDeepLinkPath(desktopMemberJoinLink(large))).toBe(
      memberJoinPath(large)
    );
  });
  it.each([
    { genesisRecordHex: 'ab'.repeat(8193) },
    { genesisRecordHex: '' },
    { genesisRecordHex: 'abc' },
    { genesisRecordHex: 'AB' },
    { workspaceId: '' },
    { workspaceId: 'a'.repeat(129) },
    { workspaceId: 'team/name' },
    { workspaceId: 'team name' },
    { expiresAt: 0 },
    { expiresAt: -1 },
    { expiresAt: 1.5 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invitation pins outside the protocol bounds (case %#)', (invalid) => {
    expect(parseMemberOffer(JSON.stringify({ ...offer, ...invalid }))).toBeNull();
  });
  it('accepts the minimum expiry and workspace identifier alphabet, but bounds total input', () => {
    const minimum = { ...offer, workspaceId: 'Team_123-abc', expiresAt: 1 };
    expect(parseMemberOffer(JSON.stringify(minimum))).toEqual(minimum);
    expect(parseMemberOffer(JSON.stringify(offer).padEnd(20481, ' '))).toBeNull();
  });
  it('publishes only unsigned pins in browser, settings and desktop invitation links', () => {
    const signed = { ...offer, signature: 'aa'.repeat(64), needsReissue: true };
    for (const link of [memberJoinPath(signed), memberInvitationUrl(signed)]) {
      const url = new URL(link, 'https://synthetic.test');
      expect(JSON.parse(new URLSearchParams(url.hash.slice(1)).get('e2ee')!)).toEqual(offer);
    }
    const desktop = new URL(desktopMemberJoinLink(signed));
    expect(JSON.parse(desktop.searchParams.get('memberOffer')!)).toEqual(offer);
    expect(signed.signature).toBe('aa'.repeat(64));
  });
  it('preserves independent genesis pins through desktop handoff and rejects a different token', () => {
    const path = resolveDesktopInviteDeepLinkPath(desktopMemberJoinLink(offer));
    expect(path).toBe(memberJoinPath(offer));
    const data = new URLSearchParams(path!.slice(path!.indexOf('#') + 1)).get('e2ee')!;
    expect(parseMemberOffer(data, offer.token)).toEqual(offer);
    expect(parseMemberOffer(data, '99'.repeat(32))).toBeNull();
  });
  it('hides sign-out verification and switch-account actions while session hydration is loading', async () => {
    const onEmailVerificationRequested = vi.fn();
    await render(
      <E2eeMemberJoin
        offer={offer}
        accountId="account"
        email="a@synthetic.test"
        emailVerified={undefined}
        loading={true}
        preview={{
          status: 'available',
          offer,
          workspaceName: 'Team',
          workspaceSlug: 'team',
          recipientEmailMasked: 'b***@synthetic.test',
          matchesRecipient: false,
        }}
        onSignInRequested={() => {}}
        onEmailVerificationRequested={onEmailVerificationRequested}
        onWorkspaceRequested={() => {}}
        onHomeRequested={() => {}}
      />
    );
    await settle();
    expect(container.textContent).toContain('e2ee.team.loading');
    expect(button('e2ee.team.verify')).toBeUndefined();
    expect(button('e2ee.team.switchAccount')).toBeUndefined();
    expect(button('e2ee.team.signIn')).toBeUndefined();
    expect(onEmailVerificationRequested).not.toHaveBeenCalled();
  });
  it('wakes immediately on subscribePendingMemberRequests, orders pending requests above billing, copies links, and clears email/loadFailed', async () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboard },
    });
    let onHint: (() => void) | undefined;
    let unsubscribed = false;
    let shouldFail = true;
    let items: E2eeMemberReplies['pending']['items'] = [];
    const emailOffer = { ...offer, mode: 'email' as const, email: 'member@synthetic.test' };
    let pendingCalls = 0;
    const runtime = {
      createMemberInvitation: async () => emailOffer,
      memberJoinRequests: async () => {
        pendingCalls++;
        if (shouldFail) throw new Error('offline');
        return {
          ...empty,
          items,
          invitations: [emailOffer],
        };
      },
      subscribePendingMemberRequests: (_workspaceId: string, changed: () => void) => {
        onHint = changed;
        return () => {
          unsubscribed = true;
        };
      },
      approveMemberJoin: async () => ({ admitted: true, keyPending: true }),
      rejectMemberJoin: async () => ({ state: 'rejected' as const }),
      revokeMemberInvitation: async () => ({ revoked: true as const }),
    };
    await render(<E2eeTeamSettings workspaceId="team" runtime={runtime} />);
    await settle();
    expect(container.textContent).toContain('e2ee.team.loadFailed');
    expect(pendingCalls).toBe(1);

    // Push hint wakes read immediately without waiting 10s, clears loadFailed, and renders requests above billing.
    shouldFail = false;
    items = [application('req-1', 'link')];
    await act(async () => onHint?.());
    await settle();
    expect(pendingCalls).toBe(2);
    expect(container.textContent).not.toContain('e2ee.team.loadFailed');
    expect(container.textContent).toContain('member@synthetic.test');
    const html = container.innerHTML;
    expect(html.indexOf('e2ee-join-request')).toBeLessThan(html.indexOf('seat quote'));

    // One-click Copy link on active invitation row copies and shows Copied feedback.
    const copyRow = container.querySelector<HTMLButtonElement>(
      '[data-testid="e2ee-invitation-copy"]'
    )!;
    await act(async () => copyRow.click());
    await settle();
    expect(clipboard).toHaveBeenCalledWith(memberInvitationUrl(emailOffer));
    expect(copyRow.textContent).toBe('e2ee.team.copied');

    // Sending an email invitation clears the input field.
    const input = container.querySelector('input[type="email"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'new@synthetic.test'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('e2ee.team.invite').click());
    await settle();
    expect(input.value).toBe('');

    await act(async () => root.unmount());
    expect(unsubscribed).toBe(true);
    root = createRoot(container);
  });
  it('renders loading, error-retry, and desktop-required states in E2eeTeamSettingsHost instead of null', async () => {
    // Missing runtime shows desktop-required notice.
    await render(<E2eeTeamSettingsHost workspaceId="team" accountId="account" />);
    expect(
      container.querySelector('[data-testid="e2ee-team-host-desktop-required"]')
    ).not.toBeNull();

    // Pending ledgerView shows loading card, then failure shows retry card.
    let failNext = true;
    let calls = 0;
    const pending = deferred<Awaited<ReturnType<E2eeWorkspaceRuntime['ledgerView']>>>();
    const runtime = {
      ledgerView: () => {
        calls++;
        if (calls === 1) return pending.promise;
        if (failNext) return Promise.reject(new Error('unavailable'));
        return Promise.resolve({
          stateHex: '',
          recordsHex: [],
          status: {
            workspaceId: 'team',
            genesisHash: '11'.repeat(32),
            length: 1,
            headHash: '11'.repeat(32),
            stateDigest: '22'.repeat(32),
            epoch: 0,
            rotationRequired: false,
            deviceKind: 'recovery',
            memberRole: 'owner',
            hasDeviceCredential: true,
            hasCurrentKey: true,
            continuityPending: false,
          },
        });
      },
    } as unknown as E2eeWorkspaceRuntime;
    await render(<E2eeTeamSettingsHost runtime={runtime} workspaceId="team" accountId="account" />);
    expect(container.querySelector('[data-testid="e2ee-team-host-loading"]')).not.toBeNull();

    // Error state exposes retry button.
    await render(
      <E2eeTeamSettingsHost
        runtime={{ ...runtime, ledgerView: runtime.ledgerView }}
        workspaceId="team"
        accountId="account"
      />
    );
    await settle();
    expect(container.querySelector('[data-testid="e2ee-team-host-error"]')).not.toBeNull();
    failNext = false;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="e2ee-team-host-retry"]')!.click()
    );
    await settle();
    expect(
      container.querySelector('[data-testid="e2ee-team-host-desktop-required"]')
    ).not.toBeNull();
  });

  it('surfaces unauthorized and conflict on member approval instead of retryOriginal', async () => {
    for (const code of ['e2ee_member_management_unauthorized', 'e2ee_member_management_conflict']) {
      await render(
        <E2eeTeamSettings
          workspaceId="team"
          runtime={{
            createMemberInvitation: async () => offer,
            memberJoinRequests: async () => ({
              ...empty,
              items: [application('applicant', 'link')],
            }),
            approveMemberJoin: async () => {
              throw Object.assign(new Error(code), { code });
            },
            rejectMemberJoin: async () => ({ state: 'rejected' }),
            revokeMemberInvitation: async () => ({ revoked: true }),
          }}
        />
      );
      await settle();
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[data-testid="e2ee-join-approve"]')!.click()
      );
      await settle();
      const expected = code.endsWith('unauthorized')
        ? 'e2ee.team.error.unauthorized'
        : 'e2ee.team.error.conflict';
      expect(container.textContent).toContain(expected);
      expect(container.textContent).not.toContain('e2ee.team.retryOriginal');
    }
  });

  it('offers direct open for existing members and separates expired links from pin mismatch', async () => {
    const opened: Array<{ slug: string | null; id?: string }> = [];
    const baseRuntime = {
      prepareMemberJoin: async () => ({ requestId: 'r1', state: 'pending' as const }),
      pendingMemberJoin: async () => null,
      claimMemberJoin: async () => ({ state: 'pending' as const, ready: false }),
    };
    await render(
      <E2eeMemberJoin
        offer={offer}
        runtime={baseRuntime}
        accountId="u1"
        emailVerified
        alreadyMember
        alreadyMemberSlug="team-slug"
        preview={{ status: 'unavailable' }}
        onSignInRequested={() => {}}
        onEmailVerificationRequested={() => {}}
        onWorkspaceRequested={(slug, id) => opened.push({ slug, id })}
        onHomeRequested={() => {}}
      />
    );
    await settle();
    expect(container.textContent).toContain('e2ee.team.alreadyMember');
    await act(async () => button('e2ee.team.openWorkspace').click());
    expect(opened).toEqual([{ slug: 'team-slug', id: offer.workspaceId }]);

    await render(
      <E2eeMemberJoin
        offer={offer}
        runtime={baseRuntime}
        accountId="u1"
        emailVerified
        preview={{ status: 'unavailable' }}
        onSignInRequested={() => {}}
        onEmailVerificationRequested={() => {}}
        onWorkspaceRequested={() => {}}
        onHomeRequested={() => {}}
      />
    );
    await settle();
    expect(container.textContent).toContain('e2ee.team.inviteExpired');

    await render(
      <E2eeMemberJoin
        offer={offer}
        runtime={baseRuntime}
        accountId="u1"
        emailVerified
        preview={{
          status: 'available',
          workspaceName: 'Team',
          workspaceSlug: 'team-slug',
          offer: { ...offer, genesisHash: 'ff'.repeat(32) },
          recipientEmailMasked: null,
          matchesRecipient: true,
        }}
        onSignInRequested={() => {}}
        onEmailVerificationRequested={() => {}}
        onWorkspaceRequested={() => {}}
        onHomeRequested={() => {}}
      />
    );
    await settle();
    expect(container.textContent).toContain('e2ee.team.pinMismatch');
  });
});
