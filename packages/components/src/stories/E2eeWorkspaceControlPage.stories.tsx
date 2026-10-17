import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { E2eeWorkspaceControlPage } from '@/components/pages/e2ee-workspace-control-page';
import { appendLedgerHistory } from '@/lib/e2ee-ledger-history';

// Synthetic signed protocol fixture. No user history or private device key.
const genesisHash = '18cb6fa187326e2f18402cba33ef7f316b8a71b0e1d026da9b79c60f6b7055de';
const page = {
  workspaceId: 'synthetic-workspace',
  genesisHash,
  checkpoint: { headHash: genesisHash, length: 1 },
  startIndex: 0,
  nextCursor: null,
  recordsHex: [
    '82860158208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c58200202020202020202020202020202020202020202020202020202020202020202500303030303030303030303030303030358200404040404040404040404040404040404040404040404040404040404040404582005050505050505050505050505050505050505050505050505050505050505055840116dc6d18360ac4d1020a255f4c4589f2bd533b045db20794f431079f298523ab37223a4d861f55ca506abb41876e2aefada1ee6931e9ca7e89c6a6235901a03',
  ],
};
const meta = {
  title: 'Pages/EncryptedWorkspace',
  component: E2eeWorkspaceControlPage,
  parameters: { layout: 'fullscreen' },
  args: {
    workspaceId: page.workspaceId,
    genesisHash,
    history: null,
    loading: false,
    failure: null,
    diagnostics: () => '{}',
    onRepairLocal: () => {},
    onResetProgress: () => {},
    onLoadMore: fn(),
    onRefresh: fn(),
    onBack: fn(),
  },
} satisfies Meta<typeof E2eeWorkspaceControlPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loading: Story = { args: { loading: true } };
export const Failed: Story = {
  args: { failure: { kind: 'server', code: 'bad-signature', position: 1 } },
};
export const ProgressConflict: Story = {
  args: { failure: { kind: 'progress-conflict', code: 'rolled-back' } },
};
export const IdentityConflict: Story = {
  args: { failure: { kind: 'identity-conflict', code: 'pin-mismatch' } },
};
export const Unsupported: Story = { args: { unavailable: true } };
export const VerifiedLocalGenesis: Story = {
  args: {
    history: appendLedgerHistory(null, page, {
      workspaceId: page.workspaceId,
      genesisHash,
      localPin: genesisHash,
    }),
  },
};
export const UnconfirmedGenesis: Story = {
  args: {
    history: appendLedgerHistory(null, page, {
      workspaceId: page.workspaceId,
      genesisHash,
      localPin: null,
    }),
  },
};
