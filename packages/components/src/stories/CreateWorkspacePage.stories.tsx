import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { CreateWorkspacePage } from '@/components/pages/create-workspace-page';

const meta = {
  title: 'Pages/CreateWorkspacePage',
  component: CreateWorkspacePage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    workspaceName: '',
    workspaceSlug: '',
    slugAvailable: false,
    canResetSlug: false,
    onWorkspaceNameChange: fn(),
    onWorkspaceSlugChange: fn(),
    onResetWorkspaceSlug: fn(),
    onSubmit: fn(),
  },
} satisfies Meta<typeof CreateWorkspacePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Ready: Story = {
  args: {
    workspaceName: 'Loro',
    workspaceSlug: 'loro',
    slugAvailable: true,
  },
};

export const WithBackButton: Story = {
  args: {
    workspaceName: 'Loro',
    workspaceSlug: 'loro',
    slugAvailable: true,
    onBackToWorkspace: fn(),
  },
};

export const CheckingSlug: Story = {
  args: {
    workspaceName: 'Loro',
    workspaceSlug: 'loro',
    slugChecking: true,
  },
};

export const SlugError: Story = {
  args: {
    workspaceName: 'Loro',
    workspaceSlug: 'loro',
    slugErrorType: 'unavailable',
    canResetSlug: true,
  },
};

export const CreateError: Story = {
  args: {
    workspaceName: 'Loro',
    workspaceSlug: 'loro',
    slugAvailable: true,
    error: 'Unable to find a workspace to open. Please try again or contact support.',
  },
};

export const Creating: Story = {
  args: {
    workspaceName: 'Loro',
    workspaceSlug: 'loro',
    slugAvailable: true,
    creating: true,
  },
};

export const PlusRequired: Story = {
  args: {
    workspaceName: 'New paid workspace',
    workspaceSlug: 'new-paid-workspace',
    slugAvailable: true,
    paidRequired: true,
    billingInterval: 'year',
    pricing: { monthlyAmountCents: 1000, yearlyAmountCents: 9600 },
    onBillingIntervalChange: fn(),
  },
};

/* Pricing query still loading — interval options render without price lines. */
export const PlusRequiredPricingLoading: Story = {
  args: {
    workspaceName: 'New paid workspace',
    workspaceSlug: 'new-paid-workspace',
    slugAvailable: true,
    paidRequired: true,
    billingInterval: 'year',
    pricing: null,
    onBillingIntervalChange: fn(),
  },
};
