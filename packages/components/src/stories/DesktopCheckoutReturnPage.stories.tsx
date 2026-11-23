import type { Meta, StoryObj } from '@storybook/react';

import { DesktopCheckoutReturnPage } from '@/components/pages/desktop-checkout-return-page';

const meta = {
  title: 'Pages/DesktopCheckoutReturnPage',
  component: DesktopCheckoutReturnPage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof DesktopCheckoutReturnPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PaymentSuccess: Story = {
  args: {
    deepLink: 'lody://checkout-return?workspaceSlug=acme&checkout=success',
    checkoutResult: 'success',
  },
};

export const CheckoutCanceled: Story = {
  args: {
    deepLink: 'lody://checkout-return?workspaceSlug=acme&checkout=canceled',
    checkoutResult: 'canceled',
  },
};

export const PortalReturn: Story = {
  args: {
    deepLink: 'lody://checkout-return?workspaceSlug=acme',
    checkoutResult: null,
  },
};

export const WaitingForDeepLink: Story = {
  args: {
    deepLink: null,
    checkoutResult: 'success',
  },
};
