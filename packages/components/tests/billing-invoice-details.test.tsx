// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BillingInvoiceDetails,
  type BillingInvoiceDetailsProps,
} from '../src/components/settings/billing-invoice-details';
import { invoiceDisplayAmount } from '../src/components/settings/billing-setting-pure';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const invoice: BillingInvoiceDetailsProps['invoice'] = {
  id: 'in_example',
  number: 'PLUS-0003',
  status: 'open',
  reason: 'seats_added',
  seatChange: { from: 1, to: 2 },
  amountPaid: 0,
  amountDue: 5741,
  amountRemaining: 5741,
  total: 5741,
  currency: 'USD',
  periodStart: 1791600775000,
  periodEnd: 1821774826000,
  interval: null,
  kind: 'subscription',
  giftDurationMonths: null,
  createdAt: 1791600775000,
  hostedInvoiceUrl: null,
};
describe('invoice details', () => {
  let root: Root;
  let container: HTMLDivElement;
  let cancellations: number;
  let props: BillingInvoiceDetailsProps;
  beforeEach(async () => {
    await initI18n('en');
    cancellations = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      invoice,
      detail: { invoice, lines: [], canCancel: true },
      loading: false,
      error: false,
      cancelPending: false,
      cancelError: false,
      onClose: () => {},
      onRetry: () => {},
      onCancel: () => {
        cancellations++;
      },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render(overrides: Partial<BillingInvoiceDetailsProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(BillingInvoiceDetails, props)));
  }
  function button(text: string) {
    return [...document.querySelectorAll('button')].find((item) => item.textContent === text);
  }
  it('uses the unpaid balance for open invoices, including partial payment and legacy responses', () => {
    expect(invoiceDisplayAmount(invoice)).toBe(5741);
    expect(invoiceDisplayAmount({ ...invoice, amountPaid: 1000, amountRemaining: 4741 })).toBe(
      4741
    );
    expect(invoiceDisplayAmount({ ...invoice, amountRemaining: null, amountDue: null })).toBeNull();
    expect(
      invoiceDisplayAmount({ ...invoice, status: 'paid', amountPaid: 5741, amountRemaining: 0 })
    ).toBe(5741);
  });
  it('shows scheduled charges with their amount, date and no cancellation', async () => {
    const scheduled = { ...invoice, status: 'draft', hostedInvoiceUrl: null };
    await render({
      invoice: scheduled,
      detail: { invoice: scheduled, lines: [], canCancel: false },
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Scheduled');
    expect(document.body.textContent).toContain('$57.41');
    expect(button('Cancel order')).toBeUndefined();
    expect(invoiceDisplayAmount(scheduled)).toBe(5741);
  });
  it('requires a second explicit click before canceling the pending expansion', async () => {
    await render();
    expect(document.body.textContent).toContain('Seats added');
    expect(document.body.textContent).toContain('$57.41');
    await act(async () => button('Cancel order')!.click());
    expect(cancellations).toBe(0);
    expect(document.body.textContent).toContain('Your existing seats');
    await act(async () => button('Confirm cancellation')!.click());
    expect(cancellations).toBe(1);
  });
  it('removes cancellation if refreshed payment state makes the invoice ineligible', async () => {
    await render();
    await act(async () => button('Cancel order')!.click());
    await render({
      detail: {
        invoice: { ...invoice, status: 'paid', amountRemaining: 0, amountPaid: 5741 },
        lines: [],
        canCancel: false,
      },
    });
    expect(button('Confirm cancellation')).toBeUndefined();
    expect(cancellations).toBe(0);
  });
  it('offers recovery rather than new cancellation after an interrupted request becomes paid', async () => {
    await render({
      detail: {
        invoice: { ...invoice, status: 'paid', amountPaid: 5741, amountRemaining: 0 },
        lines: [],
        canCancel: false,
        cancellationPending: true,
      },
    });
    expect(button('Cancel order')).toBeUndefined();
    await act(async () => button('Finish cancellation')!.click());
    expect(cancellations).toBe(1);
  });
  it.each([{ loading: true }, { error: true }, { detail: null }])(
    'does not offer cancellation without current authoritative detail %j',
    async (override) => {
      await render(override);
      expect(button('Cancel order')).toBeUndefined();
    }
  );
});
