import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, type ReactNode } from 'react';
import type { E2eeAutomaticPairingState, E2eeWorkspaceRuntime } from '@lody/platform';
import {
  E2eeAutomaticPairingInbox,
  E2eeAutomaticPairingPage,
  E2eeDeviceRequestsButton,
} from '@/components/pages/e2ee-automatic-pairing';
import { E2eeAddDeviceCard } from '@/components/pages/e2ee-instant-qr';
import { ForceDesktopLayoutProvider, ForceMobileLayoutProvider } from '@/hooks/use-mobile';

/** Synthetic one-time code; this preview never verifies or signs a request under it. */
const SYNTHETIC_PAIRING = '50M6-HA79-55MT-KTHA-DANE-PAVB-NF38';

function Layout({ form, children }: { form: 'phone' | 'desktop'; children: ReactNode }) {
  return form === 'phone' ? (
    <ForceMobileLayoutProvider force>{children}</ForceMobileLayoutProvider>
  ) : (
    <ForceDesktopLayoutProvider>{children}</ForceDesktopLayoutProvider>
  );
}

/** Production components over a synthetic capability; never performs cryptographic approval. */
function Preview({
  mode,
  backup = false,
  access,
  removal = 'removed',
  form = 'phone',
}: {
  mode: 'awaiting' | 'waiting' | 'expired' | 'syncing' | 'approval' | 'previous' | 'addDevice';
  /** This host can restore from a backup: "Can't approve on another device?" offers it first. */
  backup?: boolean;
  /** The account role the lost-access steps read; absent hides the way out. */
  access?: 'owner' | 'member';
  /** How the synthetic server answers a deletion or leave. */
  removal?: 'removed' | 'pending' | 'not-owner' | 'billing';
  /** Phones scan codes; computers show them and take typed codes. */
  form?: 'phone' | 'desktop';
}) {
  const runtime = useMemo(() => {
    const state: E2eeAutomaticPairingState & { requestId: string } = {
      id: 'synthetic-only',
      workspaceId: 'preview',
      workspaceName: 'Lody Design',
      deviceName: 'Zixuan 的 iPhone',
      requestId: 'synthetic-request',
      comparisonCode: mode === 'awaiting' ? null : '528193',
      phase:
        mode === 'approval' || mode === 'previous' || mode === 'addDevice'
          ? 'waiting'
          : mode === 'awaiting'
            ? 'preparing'
            : mode,
      expiresAt: Date.now() + 600_000,
    };
    let terminal = false;
    let wrongCodes = 0;
    let previous = mode === 'previous';
    return {
      automaticPairingState: async () => {
        if (previous)
          throw Object.assign(new Error('e2ee_pairing-elsewhere'), { code: 'pairing-elsewhere' });
        return { ...state };
      },
      accountPairingRequest: async () => ({
        lookupId: 'a1'.repeat(16),
        direction: 'approver-shows',
        pairingString: null,
        status: previous ? 'waiting' : 'expired',
        expiresAt: state.expiresAt,
        workspaces: [{ workspaceId: 'preview', name: 'Lody Design', state: 'pending' }],
      }),
      restartAutomaticPairing: async () => {
        previous = false;
        return { ...state };
      },
      startAutomaticPairing: async () => {
        state.phase = 'waiting';
        return { ...state };
      },
      cancelAutomaticPairing: async () => {
        terminal = true;
        state.phase = 'cancelled';
      },
      pendingAutomaticPairing: async () => {
        if (terminal) return [];
        const { comparisonCode: _approverNeverShowsIt, ...review } = state;
        return [review];
      },
      // Type 528193 (the code the new device shows) to authorize; the third wrong code
      // ends the request, as the real host does.
      approveAutomaticPairing: async (_id: string, code: string) => {
        if (code !== state.comparisonCode) {
          wrongCodes += 1;
          if (wrongCodes >= 3) {
            terminal = true;
            throw Object.assign(new Error('e2ee_pairing-code-locked'), {
              code: 'pairing-code-locked',
            });
          }
          throw Object.assign(new Error('e2ee_pairing-code-mismatch'), {
            code: 'pairing-code-mismatch',
            attemptsLeft: 3 - wrongCodes,
          });
        }
        terminal = true;
      },
      declineAutomaticPairing: async () => {
        terminal = true;
      },
      requestAccountPairing: async () => ({
        direction: 'approver-shows',
        pairingString: null,
        status: 'waiting',
        expiresAt: state.expiresAt,
        workspaces: [{ workspaceId: 'preview', name: 'Lody Design', state: 'pending' }],
      }),
      accountPairingCode: async () => ({
        pairingString: SYNTHETIC_PAIRING,
        expiresAt: Date.now() + 600_000,
      }),
      // No request ever arrives under the synthetic code, so nothing is signed.
      inspectAccountPairing: async () => null,
      approveAccountPairing: async () => ({ workspaces: [] }),
    } as unknown as E2eeWorkspaceRuntime;
  }, [mode]);
  if (mode === 'addDevice')
    return (
      <Layout form={form}>
        <div className="mx-auto max-w-xl p-8">
          <E2eeAddDeviceCard runtime={runtime} />
        </div>
      </Layout>
    );
  return <Layout form={form}>{body(mode, runtime, backup, access, removal)}</Layout>;
}
function body(
  mode: string,
  runtime: E2eeWorkspaceRuntime,
  backup: boolean,
  access: 'owner' | 'member' | undefined,
  removal: 'removed' | 'pending' | 'not-owner' | 'billing'
) {
  return mode === 'approval' ? (
    <E2eeAutomaticPairingInbox runtime={runtime}>
      <div className="min-h-dvh bg-background text-foreground">
        <header className="flex h-16 items-center gap-6 border-b px-6">
          <span className="font-semibold">Lody Design</span>
          <E2eeDeviceRequestsButton />
        </header>
        <main className="mx-auto max-w-2xl p-8">
          <h1 className="text-xl font-medium">设备授权预览</h1>
          <p className="mt-3 text-muted-foreground">
            此处为合成数据；审批不会连接账号或授予真实权限。
          </p>
        </main>
      </div>
    </E2eeAutomaticPairingInbox>
  ) : (
    <E2eeAutomaticPairingPage
      runtime={runtime}
      workspaceId="preview"
      onJoined={() => {}}
      onBack={() => {}}
      onManual={() => {}}
      {...(access
        ? {
            lostAccess: {
              workspaceName: 'Lody Design',
              accountRole: access,
              ...(backup
                ? {
                    recovery: {
                      passkeyAvailable: true,
                      restore: async () => ({
                        outcome: 'restored' as const,
                        results: [
                          { workspaceId: 'preview', name: 'Lody Design', outcome: 'Committed' },
                          { workspaceId: 'platform', name: 'Platform', outcome: 'Committed' },
                          { workspaceId: 'archive', name: 'Archive', outcome: 'Failed' },
                        ],
                      }),
                      onRecovered: () => {},
                    },
                  }
                : {}),
              removal: {
                submit: () =>
                  removal === 'removed'
                    ? Promise.resolve()
                    : removal === 'pending'
                      ? new Promise<void>(() => {})
                      : Promise.reject(
                          removal === 'billing'
                            ? { status: 500, message: 'Workspace has an active subscription.' }
                            : { status: 403, message: 'Forbidden' }
                        ),
                listed: async () => removal !== 'removed',
                refresh: () => {},
              },
              onBackToWorkspaces: () => {},
              onRemoved: () => {},
            },
          }
        : {})}
    />
  );
}
const meta = {
  title: 'Pages/E2eeAutomaticPairing',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
/** No signed-in device has answered yet: the page says where to go and offers scanning. */
export const PhoneAwaitingDevice: Story = { args: { mode: 'awaiting' } };
export const PhoneWaiting: Story = { args: { mode: 'waiting' } };
/** A new computer shows a QR code for a phone beside the code another computer types. */
export const DesktopNewDevice: Story = { args: { mode: 'waiting', form: 'desktop' } };
/** Open "无法在其他设备上批准？": restore first, then "我没有设置过备份" → owner deletion. */
export const PhoneWaitingWithBackup: Story = {
  args: { mode: 'waiting', backup: true, access: 'owner' },
};
/** Desktop owner without a backup host: the steps start at deletion; type the name to submit. */
export const DesktopOwnerLostAccess: Story = {
  args: { mode: 'waiting', form: 'desktop', access: 'owner' },
};
/** A non-owner sees leave instead of delete. */
export const DesktopMemberLostAccess: Story = {
  args: { mode: 'waiting', form: 'desktop', access: 'member' },
};
/** A deletion the server never answers: slow notice at 10 s, unknown at 30 s. */
export const DesktopOwnerDeletionUnanswered: Story = {
  args: { mode: 'waiting', form: 'desktop', access: 'owner', removal: 'pending' },
};
/** The server refuses on billing grounds; nothing changed. */
export const DesktopOwnerDeletionBillingRefused: Story = {
  args: { mode: 'waiting', form: 'desktop', access: 'owner', removal: 'billing' },
};
export const PhoneExpired: Story = { args: { mode: 'expired' } };
export const PhoneSyncing: Story = { args: { mode: 'syncing' } };
/** Open “Restart this device’s previous pairing” to inspect its confirmation. */
export const PhonePreviousRequest: Story = { args: { mode: 'previous' } };
/** A computer approving: reveal a QR code for a new phone, or type a new computer's code. */
export const DeviceApproval: Story = { args: { mode: 'approval', form: 'desktop' } };
/** A phone approving: scan the new device's screen, or type its code. */
export const DeviceApprovalOnPhone: Story = { args: { mode: 'approval' } };
/** The console's Devices tab entry. */
export const AddDeviceCard: Story = { args: { mode: 'addDevice', form: 'desktop' } };
