import type { Meta, StoryObj } from '@storybook/react';
import { PiProviderMigrationCard } from '../components/chat/pi-provider-migration-card';

const meta = {
  title: 'Chat/Pi provider migration',
  component: PiProviderMigrationCard,
  args: { count: 2, busy: false, error: false, canMigrate: true, onConfirm: () => {} },
} satisfies Meta<typeof PiProviderMigrationCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Confirmation: Story = {};
export const Migrating: Story = { args: { busy: true } };
export const Retry: Story = { args: { error: true } };
export const UpgradeMachine: Story = { args: { canMigrate: false } };
