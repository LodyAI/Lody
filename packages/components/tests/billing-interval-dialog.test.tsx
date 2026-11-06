// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { BillingIntervalDialog } from '../src/components/settings/billing-interval-dialog';
import { initI18n } from '../src/i18n';
let root: Root;
let host: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(async () => {
  await initI18n('en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const props = {
  open: true,
  onOpenChange: () => {},
  interval: 'month' as const,
  pending: false,
  preview: null,
  onConfirm: () => {},
  onRetry: () => {},
  onPaymentMethod: () => {},
  onViewInvoices: () => {},
};
it('keeps confirmation disabled when quoting failed and offers recalculation', async () => {
  const retry = vi.fn();
  await act(async () =>
    root.render(createElement(BillingIntervalDialog, { ...props, onRetry: retry }))
  );
  const buttons = [...document.querySelectorAll('button')];
  expect(buttons.find((b) => b.textContent?.includes('Confirm switch'))?.disabled).toBe(true);
  await act(async () => buttons.find((b) => b.textContent?.includes('Recalculate'))!.click());
  expect(retry).toHaveBeenCalledOnce();
});
it('separates a completed switch from an unpaid invoice and links to payment', async () => {
  await act(async () =>
    root.render(
      createElement(BillingIntervalDialog, {
        ...props,
        result: {
          billingInterval: 'month',
          effectiveAt: null,
          payment: {
            status: 'required',
            amountRemaining: 1969,
            currency: 'usd',
            invoiceUrl: 'https://invoice.stripe.com/i/example',
          },
        },
      })
    )
  );
  expect(document.body.textContent).toContain('Billing interval updated');
  expect(document.body.textContent).toContain('19.69');
  expect(document.querySelector('a')?.href).toBe('https://invoice.stripe.com/i/example');
  expect(
    [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Confirm switch'))
  ).toBe(false);
});

it.each([
  ['billing_payment_required', 'View outstanding invoice', 'onViewInvoices'],
  ['billing_payment_method_required', 'Update payment method', 'onPaymentMethod'],
] as const)(
  'blocks switching until %s is resolved and exposes the required action',
  async (errorCode, label, action) => {
    const resolve = vi.fn();
    const confirm = vi.fn();
    await act(async () =>
      root.render(
        createElement(BillingIntervalDialog, {
          ...props,
          errorCode,
          onConfirm: confirm,
          [action]: resolve,
        })
      )
    );
    const buttons = [...document.querySelectorAll('button')];
    const switchButton = buttons.find((button) => button.textContent?.includes('Confirm switch'))!;
    expect(switchButton.disabled).toBe(true);
    await act(async () => switchButton.click());
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => buttons.find((button) => button.textContent === label)!.click());
    expect(resolve).toHaveBeenCalledOnce();
  }
);

it('lets a completed switch refresh payment without offering another switch', async () => {
  const refresh = vi.fn();
  await act(async () =>
    root.render(
      createElement(BillingIntervalDialog, {
        ...props,
        onRetry: refresh,
        result: { billingInterval: 'month', effectiveAt: null, payment: { status: 'checking' } },
      })
    )
  );
  const buttons = [...document.querySelectorAll('button')];
  expect(buttons.some((button) => button.textContent?.includes('Confirm switch'))).toBe(false);
  await act(async () =>
    buttons.find((button) => button.textContent === 'Check payment status')!.click()
  );
  expect(refresh).toHaveBeenCalledOnce();
});

it('offers a direct payment link when several outstanding invoices require settlement', async () => {
  await act(async () =>
    root.render(
      createElement(BillingIntervalDialog, {
        ...props,
        result: {
          billingInterval: 'month',
          effectiveAt: null,
          payment: {
            status: 'required',
            amountRemaining: 300,
            currency: 'usd',
            invoiceUrl: null,
            outstandingInvoices: [
              {
                id: 'in_1',
                amountRemaining: 100,
                currency: 'usd',
                invoiceUrl: 'https://invoice.stripe.com/i/1',
              },
              {
                id: 'in_2',
                amountRemaining: 200,
                currency: 'usd',
                invoiceUrl: 'https://invoice.stripe.com/i/2',
              },
            ],
          },
        },
      })
    )
  );
  expect(document.querySelector<HTMLAnchorElement>('a')?.href).toBe(
    'https://invoice.stripe.com/i/1'
  );
  expect(document.body.textContent).toContain('2 outstanding invoices');
});

it('shows a failed payment refresh even after the interval has changed', async () => {
  await act(async () =>
    root.render(
      createElement(BillingIntervalDialog, {
        ...props,
        errorCode: 'payment_status_unavailable',
        result: { billingInterval: 'month', effectiveAt: null, payment: { status: 'checking' } },
      })
    )
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Unable to refresh');
});

it('does not suggest recalculating a managed subscription that cannot switch', async () => {
  await act(async () =>
    root.render(
      createElement(BillingIntervalDialog, { ...props, errorCode: 'managed_subscription_interval' })
    )
  );
  expect(
    [...document.querySelectorAll('button')].some((b) => b.textContent === 'Recalculate')
  ).toBe(false);
});

it('keeps payment links for partial mixed-currency invoices without showing a false zero total', async () => {
  await act(async () =>
    root.render(
      createElement(BillingIntervalDialog, {
        ...props,
        result: {
          billingInterval: 'month',
          effectiveAt: null,
          payment: {
            status: 'required',
            hasMore: true,
            outstandingInvoices: [
              {
                id: 'in_usd',
                amountRemaining: 100,
                currency: 'usd',
                invoiceUrl: 'https://invoice.stripe.com/i/usd',
              },
              {
                id: 'in_eur',
                amountRemaining: 200,
                currency: 'eur',
                invoiceUrl: 'https://invoice.stripe.com/i/eur',
              },
            ],
          },
        },
      })
    )
  );
  expect(document.body.textContent).toContain('own currency');
  expect(document.body.textContent).toContain('remaining invoices');
  expect(document.body.textContent).not.toContain('$0.00');
  expect(document.querySelector<HTMLAnchorElement>('a')?.href).toBe(
    'https://invoice.stripe.com/i/usd'
  );
});
