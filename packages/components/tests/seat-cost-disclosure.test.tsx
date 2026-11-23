// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  InviteMemberDialog,
  SeatCostNotice,
} from '../src/components/settings/invite-member-dialog';
import { InviteScreenView } from '../src/components/onboarding/screens/invite-screen';
import { AcceptInvitationPage } from '../src/components/pages/accept-invitation-page';
import { initI18n } from '../src/i18n';

let root: Root;
let container: HTMLDivElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
beforeEach(async () => {
  await initI18n('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('discloses seat fees on native shells even when purchase navigation is unavailable', async () => {
  await act(async () =>
    root.render(
      createElement(InviteMemberDialog, {
        open: true,
        onOpenChange: () => {},
        workspaceName: 'Example',
        onInvite: () => {},
        billingUiAvailable: false,
        seatPreview: {
          status: 'billed',
          interval: 'year',
          unitAmount: 9600,
          proratedAmount: 3120,
          currentPeriodEnd: Date.UTC(2027, 1, 14),
          seatCount: 5,
          nextSeatCount: 6,
          nextRenewalAmount: 57600,
        },
      })
    )
  );
  expect(document.body.textContent).toContain('31.20');
});

it('shows unavailable pricing instead of silently hiding the fee disclosure', async () => {
  await act(async () => root.render(createElement(SeatCostNotice, { preview: null })));
  expect(container.textContent).toContain('Unable to calculate');
});

it('does not send an invitation before a priced admission estimate is available', async () => {
  const onInvite = vi.fn();
  await act(async () =>
    root.render(
      createElement(InviteMemberDialog, {
        open: true,
        onOpenChange: () => {},
        workspaceName: 'Example',
        onInvite,
        seatPreview: {
          status: 'billed',
          interval: 'month',
          unitAmount: 1000,
          proratedAmount: null,
          currentPeriodEnd: null,
          seatCount: 1,
          nextSeatCount: 2,
          nextRenewalAmount: null,
        },
      })
    )
  );
  const email = document.querySelector<HTMLInputElement>('#invite-email')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      email,
      'member@example.com'
    );
    email.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Invite')!;
  expect(button.disabled).toBe(true);
  await act(async () =>
    email.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  expect(onInvite).not.toHaveBeenCalled();
});

it('shows the batch fee before onboarding can send invitations', async () => {
  await act(async () =>
    root.render(
      createElement(InviteScreenView, {
        email: '',
        onEmailChange: () => {},
        onAdd: () => {},
        onRemove: () => {},
        invites: [{ id: 'i1', email: 'member@example.com', status: 'pending' }],
        sending: false,
        inputError: null,
        onSkip: () => {},
        onBack: () => {},
        onSendAndContinue: () => {},
        seatPreview: {
          status: 'billed',
          interval: 'month',
          unitAmount: 1000,
          proratedAmount: 581,
          currentPeriodEnd: Date.UTC(2026, 10, 24),
          seatCount: 1,
          nextSeatCount: 2,
          nextRenewalAmount: 2000,
        },
      })
    )
  );
  expect(container.textContent).toContain('5.81');
});

it('lets an invited member retry after the administrator resolves billing', async () => {
  const retry = vi.fn();
  await act(async () =>
    root.render(
      createElement(AcceptInvitationPage, {
        state: 'billing_blocked',
        errorMessage: 'Ask your administrator to resolve billing.',
        onAccept: retry,
      })
    )
  );
  const button = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Try joining again')
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(retry).toHaveBeenCalledOnce();
});

it.each(['method_required', 'payment_required', 'refresh'] as const)(
  'requires payment recovery before approving a billed seat: %s',
  async (paymentAction) => {
    const { SeatAdmissionActions, isSeatAdmissionReady } =
      await import('../src/components/settings/invite-member-dialog');
    const preview = {
      status: 'billed' as const,
      interval: 'month' as const,
      unitAmount: 1000,
      proratedAmount: 500,
      currentPeriodEnd: 10000,
      seatCount: 1,
      nextSeatCount: 2,
      nextRenewalAmount: 2000,
      paymentAction,
    };
    expect(isSeatAdmissionReady(preview)).toBe(false);
    const resolve = vi.fn();
    await act(async () =>
      root.render(
        createElement(SeatAdmissionActions, {
          preview,
          pending: false,
          onRefresh: resolve,
          onOpenBilling: resolve,
        })
      )
    );
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    await act(async () => buttons[0]!.click());
    expect(resolve).toHaveBeenCalledOnce();
  }
);
