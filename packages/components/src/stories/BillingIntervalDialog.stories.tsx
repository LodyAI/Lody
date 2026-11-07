import type { Meta, StoryObj } from '@storybook/react';
import { BillingIntervalDialog } from '@/components/settings/billing-interval-dialog';
const meta = {
  title: 'Settings/BillingIntervalDialog',
  component: BillingIntervalDialog,
  globals: { locale: 'zh_CN' },
  args: {
    open: true,
    onOpenChange: () => {},
    interval: 'month',
    pending: false,
    onConfirm: () => {},
    onRetry: () => {},
    onPaymentMethod: () => {},
    onViewInvoices: () => {},
    preview: {
      quoteId: 'quote_example',
      currency: 'usd',
      interval: 'month',
      quantity: 20,
      unitAmount: 1000,
      subtotalAmount: 20000,
      promoDiscountAmount: 0,
      creditAmount: -10594,
      deferredToBalanceAmount: 0,
      amountDueNow: 9406,
      remainingCredit: 0,
      nextRenewalAt: Date.UTC(2026, 11, 6),
      promoApplied: false,
    },
  },
} satisfies Meta<typeof BillingIntervalDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Quote: Story = {};
export const QuoteFailed: Story = { args: { preview: null } };
export const PaymentMethodRequired: Story = {
  args: { errorCode: 'billing_payment_method_required' },
};
export const SwitchedPaymentDue: Story = {
  args: {
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
  },
};
export const SwitchedChecking: Story = {
  args: {
    result: { billingInterval: 'month', effectiveAt: null, payment: { status: 'checking' } },
  },
};

export const AccruedSeats: Story = {
  args: { preview: { ...meta.args.preview, accruedSeatAmount: 316, amountDueNow: 9722 } },
};
export const Resume: Story = { args: { preview: { ...meta.args.preview, continuation: true } } };
export const OutstandingBeforeSwitch: Story = {
  args: { errorCode: 'billing_payment_required' },
};
export const MultipleInvoices: Story = {
  args: {
    result: {
      billingInterval: 'month',
      effectiveAt: null,
      payment: {
        status: 'required',
        amountRemaining: 1969,
        currency: 'usd',
        invoiceUrl: null,
        outstandingInvoices: [
          {
            id: 'in_seats',
            amountRemaining: 316,
            currency: 'usd',
            invoiceUrl: 'https://invoice.stripe.com/i/example-seats',
          },
          {
            id: 'in_month',
            amountRemaining: 1653,
            currency: 'usd',
            invoiceUrl: 'https://invoice.stripe.com/i/example-month',
          },
        ],
      },
    },
  },
};
export const PaymentRefreshFailed: Story = {
  args: { ...SwitchedChecking.args, errorCode: 'payment_status_unavailable' },
};
export const ManagedSubscription: Story = {
  args: { preview: null, errorCode: 'managed_subscription_interval' },
};
export const TaxAndBalance: Story = {
  args: {
    preview: {
      ...meta.args.preview,
      taxAmount: 1500,
      balanceAmount: -1000,
      adjustmentAmount: 0,
      amountDueNow: 9906,
    },
  },
};
export const PaymentLinkUnavailable: Story = {
  args: {
    result: {
      billingInterval: 'month',
      effectiveAt: null,
      payment: {
        status: 'required',
        amountRemaining: 1969,
        currency: 'usd',
        outstandingInvoices: [
          { id: 'in_example', amountRemaining: 1969, currency: 'usd', invoiceUrl: null },
        ],
      },
    },
  },
};
export const PartialMixedInvoices: Story = {
  args: {
    result: {
      billingInterval: 'month',
      effectiveAt: null,
      payment: {
        status: 'required',
        hasMore: true,
        outstandingInvoices: [
          {
            id: 'in_usd',
            amountRemaining: 316,
            currency: 'usd',
            invoiceUrl: 'https://invoice.stripe.com/i/example-usd',
          },
          {
            id: 'in_eur',
            amountRemaining: 1653,
            currency: 'eur',
            invoiceUrl: 'https://invoice.stripe.com/i/example-eur',
          },
        ],
      },
    },
  },
};
