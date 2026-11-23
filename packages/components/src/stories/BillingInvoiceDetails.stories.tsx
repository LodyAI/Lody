import type { Meta, StoryObj } from '@storybook/react';
import { BillingInvoiceDetails } from '@/components/settings/billing-invoice-details';

const invoice = {
  id: 'in_example',
  number: 'PLUS-0003',
  status: 'open',
  reason: 'seats_added' as const,
  seatChange: { from: 1, to: 2 },
  amountPaid: 0,
  amountDue: 5741,
  amountRemaining: 5741,
  total: 5741,
  currency: 'USD',
  periodStart: 1791600775000,
  periodEnd: 1821774826000,
  interval: null,
  kind: 'subscription' as const,
  giftDurationMonths: null,
  createdAt: 1791600775000,
  hostedInvoiceUrl: 'https://invoice.stripe.com/i/example',
};
const detail = {
  invoice,
  canCancel: true,
  lines: [
    {
      id: 'line_credit',
      description: 'Unused time on Plus — 1 seat',
      amount: -5741,
      quantity: 1,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
    },
    {
      id: 'line_charge',
      description: 'Remaining time on Plus — 2 seats',
      amount: 11482,
      quantity: 2,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
    },
  ],
};
const meta: Meta<typeof BillingInvoiceDetails> = {
  title: 'Settings/BillingInvoiceDetails',
  component: BillingInvoiceDetails,
  args: {
    invoice,
    detail,
    loading: false,
    error: false,
    cancelPending: false,
    cancelError: false,
    onClose: () => {},
    onRetry: () => {},
    onCancel: () => {},
  },
};
export default meta;
type Story = StoryObj<typeof BillingInvoiceDetails>;
export const PendingSeatAddition: Story = {};
export const AppliedUnpaidInvoice: Story = { args: { detail: { ...detail, canCancel: false } } };
export const Loading: Story = { args: { detail: null, loading: true } };
export const LoadError: Story = { args: { detail: null, error: true } };
export const PaymentCompleted: Story = {
  args: {
    detail: {
      ...detail,
      canCancel: false,
      invoice: { ...invoice, status: 'paid', amountPaid: 5741, amountRemaining: 0 },
    },
  },
};
export const CancellationFailed: Story = { args: { cancelError: true } };

export const ScheduledAnnualSeats: Story = {
  args: {
    invoice: { ...invoice, status: 'draft', hostedInvoiceUrl: null },
    detail: {
      ...detail,
      canCancel: false,
      invoice: { ...invoice, status: 'draft', hostedInvoiceUrl: null },
      lines: [
        {
          id: 'seat',
          description: 'Additional seats: +1',
          amount: 5741,
          quantity: 1,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
        },
      ],
    },
  },
};
