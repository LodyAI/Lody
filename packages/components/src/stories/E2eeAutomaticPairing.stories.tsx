import type { Meta, StoryObj } from '@storybook/react';
import { useMemo } from 'react';
import type { E2eeAutomaticPairingState, E2eeWorkspaceRuntime } from '@lody/platform';
import {
  E2eeAutomaticPairingInbox,
  E2eeAutomaticPairingPage,
  E2eeDeviceRequestsButton,
} from '@/components/pages/e2ee-automatic-pairing';

/** Production components over a synthetic capability; never performs cryptographic approval. */
function Preview({
  mode,
  backup = false,
}: {
  mode: 'waiting' | 'expired' | 'syncing' | 'approval' | 'previous';
  /** This host can restore from a backup: "No other authorized device?" offers it. */
  backup?: boolean;
}) {
  const runtime = useMemo(() => {
    const state: E2eeAutomaticPairingState & { requestId: string } = {
      id: 'synthetic-only',
      workspaceId: 'preview',
      workspaceName: 'Lody Design',
      deviceName: 'Zixuan 的 iPhone',
      requestId: 'synthetic-request',
      comparisonCode: '528193',
      phase: mode === 'approval' || mode === 'previous' ? 'waiting' : mode,
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
    } as unknown as E2eeWorkspaceRuntime;
  }, [mode]);
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
      {...(backup
        ? {
            lostAll: {
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
export const PhoneWaiting: Story = { args: { mode: 'waiting' } };
/** Open "没有其他已授权设备？" → "用备份找回" for the passkey / file / neither choice. */
export const PhoneWaitingWithBackup: Story = { args: { mode: 'waiting', backup: true } };
export const PhoneExpired: Story = { args: { mode: 'expired' } };
export const PhoneSyncing: Story = { args: { mode: 'syncing' } };
/** Open “Restart this device’s previous pairing” to inspect its confirmation. */
export const PhonePreviousRequest: Story = { args: { mode: 'previous' } };
export const DeviceApproval: Story = { args: { mode: 'approval' } };
