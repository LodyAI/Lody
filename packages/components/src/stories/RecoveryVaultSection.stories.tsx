import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { developerModeEnabledAtom, e2eeRecoveryVaultEnabledAtom } from '@/atoms/settings';
import { RecoveryVaultSection } from '@/components/settings/e2ee/recovery-vault-section';
import {
  E2eeRecoveryHostContext,
  type RecoveryPlan,
  type RecoveryPort,
} from '@/components/settings/e2ee/recovery-port';

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
      if (channel === 'app.setNativeTheme' || channel === 'app.setStartupThemeSource')
        return undefined;
      if (channel === 'e2ee.recentAccountSecurityEvents') return [];
      if (channel === 'e2ee.recoveryPasskeyAvailable') return true;
      throw new Error(`unexpected invoke ${channel}`);
    },
    on: () => () => {},
    send: () => {},
  };
}

/** A browser-shaped host (Web, the mobile webview): no file check or replacement, and
 * creating a file only where the host can save one. Actions it lacks are not shown. */
function browserPort(plan: Plan, canCreate: boolean): RecoveryPort {
  const never = () => new Promise<never>(() => {});
  return {
    plan: async () => plan as RecoveryPlan,
    securityEvents: async () => [],
    passkeyAvailable: async () => true,
    create: canCreate ? never : null,
    restore: never,
    setupWorkspace: never,
    setupWorkspaces: never,
    passkeyDefaultLabel: never,
    addPasskey: never,
    listPasskeys: never,
    removePasskey: never,
    checkFile: null,
    replacement: null,
  };
}

function Harness({ plan, browser }: { plan: PlanAnswer; browser?: { canCreate: boolean } }) {
  if (!browser) installIpc(plan);
  const store = createStore();
  store.set(developerModeEnabledAtom, true);
  store.set(e2eeRecoveryVaultEnabledAtom, true);
  const host =
    browser && plan !== 'unreadable' ? { port: browserPort(plan, browser.canCreate) } : null;
  return (
    <Provider store={store}>
      <E2eeRecoveryHostContext.Provider value={host}>
        {/* Follows the viewport, so narrow viewports show how the rows wrap. */}
        <div className="w-full max-w-[640px] bg-background p-4">
          <RecoveryVaultSection />
        </div>
      </E2eeRecoveryHostContext.Provider>
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

// Every workspace covered: no warning, checking the saved file is the one primary action.
export const AllCovered: Story = {
  args: {
    plan: {
      hasVault: true,
      replaceable: true,
      replacing: false,
      covered: [
        workspace('b', 'Platform', { kind: 'saved' }),
        workspace('c', 'Research', { kind: 'verified', update: 3 }),
      ],
      uncovered: [],
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

export const BrowserHostReady: Story = {
  args: { ...Ready.args, browser: { canCreate: true } },
};

export const BrowserHostReplacingElsewhere: Story = {
  args: { ...ReplacingWithUncovered.args, browser: { canCreate: true } },
};

export const MobileHostNoVault: Story = {
  args: { ...NoVault.args, browser: { canCreate: false } },
};
