import type { Meta, StoryObj } from '@storybook/react';
import {
  createIndexedDbSessionLifecycleAdmissionStore,
  getSessionLifecycleIndexedDbName,
} from '@/lib/session-lifecycle-persistence';

const SessionLifecyclePersistenceHarness = () => {
  Object.assign(window, {
    __lodySessionLifecyclePersistence: {
      createStore: createIndexedDbSessionLifecycleAdmissionStore,
      getDatabaseName: getSessionLifecycleIndexedDbName,
    },
  });
  return <div data-testid="session-lifecycle-persistence-ready">ready</div>;
};

const meta = {
  title: 'Infrastructure/SessionLifecyclePersistence',
  component: SessionLifecyclePersistenceHarness,
} satisfies Meta<typeof SessionLifecyclePersistenceHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BrowserHarness: Story = {};
