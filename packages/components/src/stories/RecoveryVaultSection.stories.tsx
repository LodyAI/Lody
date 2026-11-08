import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { developerModeEnabledAtom, e2eeRecoveryVaultEnabledAtom } from '@/atoms/settings';
import { RecoveryVaultSection } from '@/components/settings/e2ee/recovery-vault-section';

type Plan = Record<string, unknown>;
/** `'unreadable'` makes the desktop refuse the plan, as when its journal cannot be read. */
type PlanAnswer = Plan | 'unreadable';

function installIpc(plan: PlanAnswer): void {
  if (typeof window === 'undefined') return;
  window.__LODY_ELECTRON__ = true;
  window.ipc = {
    invoke: async (channel) => {
      if (channel === 'e2ee.recoveryReplacementPlan') {
        if (plan === 'unreadable') throw new Error('e2ee_recovery_storage');
        return plan;
      }
      // The theme provider mirrors the committed theme to the desktop.
      if (channel === 'app.setNativeTheme') return undefined;
      if (channel === 'e2ee.recentAccountSecurityEvents') return [];
      if (channel === 'e2ee.recoveryPasskeyAvailable') return true;
      throw new Error(`unexpected invoke ${channel}`);
    },
    on: () => () => {},
    send: () => {},
  };
}

function Harness({ plan }: { plan: PlanAnswer }) {
  installIpc(plan);
  const store = createStore();
  store.set(developerModeEnabledAtom, true);
  store.set(e2eeRecoveryVaultEnabledAtom, true);
  return (
    <Provider store={store}>
      {/* Follows the viewport, so narrow viewports show how the rows wrap. */}
      <div className="w-full max-w-[640px] bg-background p-4">
        <RecoveryVaultSection />
      </div>
    </Provider>
  );
}

const workspace = (id: string, name: string, status: Plan) => ({ id, name, status });

const meta = {
  title: 'Settings/RecoveryVaultSection',
  component: Harness,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoVault: Story = {
  args: {
    plan: {
      hasVault: false,
      replaceable: false,
      replacing: false,
      covered: [workspace('a', 'Design', { kind: 'notSet' })],
      uncovered: [],
    },
  },
};

export const Ready: Story = {
  args: {
    plan: {
      hasVault: true,
      replaceable: true,
      replacing: false,
      covered: [
        workspace('a', 'Design', { kind: 'notSet' }),
        workspace('b', 'Platform', { kind: 'saved' }),
        workspace('c', 'Research', { kind: 'verified', update: 3 }),
        workspace('e', 'Operations', { kind: 'unknown' }),
      ],
      uncovered: [workspace('d', 'Archive', { kind: 'notSet' })],
    },
  },
};

export const Replacing: Story = {
  args: {
    plan: {
      hasVault: true,
      replaceable: true,
      replacing: true,
      covered: [workspace('c', 'Research', { kind: 'verified', update: 3 })],
      uncovered: [],
    },
  },
};

export const ReplacingWithUncovered: Story = {
  args: {
    plan: {
      hasVault: true,
      replaceable: true,
      replacing: true,
      covered: [workspace('c', 'Research', { kind: 'verified', update: 3 })],
      uncovered: [workspace('d', 'Archive', { kind: 'notSet' })],
    },
  },
};

export const StatusUnreadable: Story = {
  args: { plan: 'unreadable' },
};
