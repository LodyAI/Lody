import type { Meta, StoryObj } from '@storybook/react';
import { StorageCrisisRecoveryView } from '@/components/storage-crisis-dialog';

/**
 * The blocking screen shown when the renderer's Loro repo IndexedDB is full or
 * has died. It is not dismissible: every repo write from here fails, so the
 * only way out is freeing disk space and restarting the process.
 */
const meta: Meta<typeof StorageCrisisRecoveryView> = {
  title: 'Components/StorageCrisisRecovery',
  component: StorageCrisisRecoveryView,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    isDesktop: true,
    actionPending: false,
    onRestart: () => {},
    onQuit: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof StorageCrisisRecoveryView>;

/** The sticky aftermath error users actually hit: the connection is dead. */
export const ConnectionUnavailable: Story = {
  args: {
    crisis: {
      kind: 'unavailable',
      operation: 'loadDoc',
      detail:
        "InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    },
  },
};

/** The first failure, when a write is rejected for lack of space. */
export const QuotaExceeded: Story = {
  args: {
    crisis: {
      kind: 'quota',
      operation: 'save',
      detail: "QuotaExceededError: Failed to execute 'put' on 'IDBObjectStore'.",
    },
  },
};

/** Browser shell: there is no process to relaunch, so a reload is the action. */
export const BrowserShell: Story = {
  args: {
    isDesktop: false,
    crisis: {
      kind: 'quota',
      operation: 'save',
      detail: "QuotaExceededError: Failed to execute 'put' on 'IDBObjectStore'.",
    },
  },
};

/** Both actions lock while a relaunch is already underway. */
export const RestartInFlight: Story = {
  args: {
    actionPending: true,
    crisis: {
      kind: 'unavailable',
      operation: 'save',
      detail: 'InvalidStateError: The database connection is closing.',
    },
  },
};
