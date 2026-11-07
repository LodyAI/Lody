import type { Meta, StoryObj } from '@storybook/react';
import { SeatApprovalDialog } from '@/components/settings/workspace-join-requests-settings';
const meta = {
  title: 'Settings/SeatApprovalDialog',
  component: SeatApprovalDialog,
  globals: { locale: 'zh_CN' },
  args: {
    open: true,
    onOpenChange: () => {},
    pending: false,
    onOpenBilling: () => {},
    onRefresh: () => {},
    onApprove: () => {},
    preview: {
      status: 'billed',
      interval: 'month',
      unitAmount: 1000,
      proratedAmount: 581,
      currentPeriodEnd: Date.UTC(2026, 10, 24),
      invoiceAt: Date.UTC(2026, 10, 24),
      seatCount: 1,
      nextSeatCount: 2,
      nextRenewalAmount: 2000,
      paymentAction: 'payment_required',
    },
  },
} satisfies Meta<typeof SeatApprovalDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PaymentRequired: Story = {};
export const MethodRequired: Story = {
  args: { preview: { ...meta.args.preview, paymentAction: 'method_required' } },
};
export const RefreshRequired: Story = {
  args: { preview: { ...meta.args.preview, paymentAction: 'refresh' } },
};
