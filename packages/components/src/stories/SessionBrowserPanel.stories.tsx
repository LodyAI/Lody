import { act, useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { expect, userEvent, within } from 'storybook/test';
import {
  getMachineRoomId,
  type MachineId,
  type MachineMeta,
  type PreviewConnection,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { runtimeAtom, userAtom, type WorkspaceRuntime } from '@/atoms';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';
import { lodyPresenceSyncStateAtom } from '@/atoms/presence';
import { SessionBrowserPanel } from '@/components/sessions/session-browser-panel';
import { clearSessionBrowserResumeState } from '@/components/sessions/session-browser-resume-state';

type Scenario =
  | 'empty'
  | 'candidate'
  | 'connecting'
  | 'failed'
  | 'timeout'
  | 'expired'
  | 'revoked'
  | 'offline'
  | 'owner'
  | 'archived'
  | 'unavailable';
const target = {
  protocol: 'http' as const,
  host: 'localhost',
  port: 5173,
  path: '/dashboard?mode=dev',
};
const session: SessionMeta = {
  id: 'session-browser' as SessionId,
  machineId: 'machine-browser' as MachineId,
  createdAt: '2026-09-23T00:00:00.000Z',
  userId: 'user-1',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
};

function StoryShell({ scenario = 'empty' }: { scenario?: Scenario }) {
  const fixture = useMemo(() => {
    const storySession = {
      ...session,
      id: `session-browser-${scenario}` as SessionId,
      isArchived: scenario === 'archived',
    };
    clearSessionBrowserResumeState(storySession.id);
    const store = createStore();
    store.set(userAtom, {
      id: scenario === 'owner' ? 'other-user' : 'user-1',
      name: 'Browser User',
      email: 'browser@example.com',
    });
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(session.machineId)]: {
        id: session.machineId,
        name: 'Build Mac',
      } as MachineMeta,
    });
    if (scenario === 'offline') store.set(lodyPresenceSyncStateAtom, 'synced');
    const connection: PreviewConnection | undefined = [
      'expired',
      'revoked',
      'offline',
      'owner',
      'archived',
    ].includes(scenario)
      ? {
          status: 'closed',
          target,
          closedReason: scenario === 'revoked' ? 'revoked' : 'idle_timeout',
          updatedAt: 1,
        }
      : undefined;
    const state = {
      session: { id: storySession.id },
      mq: [],
      preview: {
        connection,
        candidate: scenario === 'candidate' ? { status: 'available', target } : undefined,
      },
    };
    const sessionStore = {
      sessionId: storySession.id,
      roomId: `session:${storySession.id}`,
      doc: null,
      firstSynced: Promise.resolve(),
      acquireSync: () => () => {},
      getSyncState: () => 'synced' as const,
      subscribeSyncState: () => () => {},
      getState: () => state,
      subscribe: () => () => {},
      dispose: () => {},
      waitUntilSynced: async () => {},
    };
    const runtime = {
      workspaceSlug: 'workspace-browser',
      workspaceId: 'workspace-browser-id' as WorkspaceId,
      acquireSessionStore: async () => sessionStore,
      releaseSessionStoreRef: () => {},
      resolveMachineTargetPlane: async () => 'cloud' as const,
      requestSessionPreviewStatus: async () => ({
        type: 'session/preview-status_response',
        sessionId: storySession.id,
        success: true,
        connection,
      }),
      requestSessionPreviewCreate: async () => {
        if (scenario === 'timeout') return null;
        if (scenario === 'failed')
          return {
            type: 'session/preview-create_response',
            sessionId: storySession.id,
            success: false,
            message: 'cloudflared download failed (HTTP 404)',
          };
        return new Promise<never>(() => {});
      },
    } as unknown as WorkspaceRuntime;
    store.set(runtimeAtom, scenario === 'unavailable' ? null : runtime);
    return { store, storySession };
  }, [scenario]);
  return (
    <Provider store={fixture.store}>
      <SessionBrowserPanel session={fixture.storySession} />
    </Provider>
  );
}

const meta = {
  title: 'Sessions/Browser Preview/Controller',
  component: StoryShell,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Real SessionBrowserPanel controller with synthetic Machine RPC and document data. Enter and Restore use production handlers; pending RPCs are explicit, without sleeps or live tunnels.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ height: '100vh' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StoryShell>;
export default meta;
type Story = StoryObj<typeof meta>;

const enterAddress: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const input = canvas.getByRole('textbox', { name: 'Address' }) as HTMLInputElement;
  // Storybook's synchronous user-event act wrapper cannot await this controller's
  // async route resolution. Dispatch the native input/submit boundary in awaited
  // act scopes; the Playwright sweep separately presses the real Enter key.
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'localhost:5173/dashboard?mode=dev'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.form!.requestSubmit();
    });
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument();
};
export const Empty: Story = {};
export const CandidateAvailable: Story = {
  args: { scenario: 'candidate' },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(/Press Enter to open/);
  },
};
export const ConnectingRemote: Story = {
  args: { scenario: 'connecting' },
  play: async (context) => {
    await enterAddress(context);
    await within(context.canvasElement).findByText('Establishing a secure preview connection…');
  },
};
export const DownloadFailed: Story = {
  args: { scenario: 'failed' },
  play: async (context) => {
    await enterAddress(context);
    await within(context.canvasElement).findByText('cloudflared download failed (HTTP 404)');
  },
};
export const RequestTimedOut: Story = {
  args: { scenario: 'timeout' },
  play: async (context) => {
    await enterAddress(context);
    await within(context.canvasElement).findByText('Browser request timed out.');
  },
};
export const Expired: Story = {
  args: { scenario: 'expired' },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('Preview link expired');
  },
};
export const Revoked: Story = {
  args: { scenario: 'revoked' },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('button', { name: 'Reopen preview' });
  },
};
export const RestoreStartsNewTunnel: Story = {
  args: { scenario: 'expired' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const restore = await canvas.findByRole('button', { name: 'Restore preview' });
    await userEvent.click(restore);
    await canvas.findByText('Creating preview link…');
    await expect(canvas.getByRole('textbox', { name: 'Address' })).toHaveValue(
      'http://localhost:5173/dashboard?mode=dev'
    );
  },
};
export const MachineOffline: Story = { args: { scenario: 'offline' } };
export const OwnerRequired: Story = { args: { scenario: 'owner' } };
export const ArchivedSession: Story = { args: { scenario: 'archived' } };
export const RuntimeUnavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async (context) => {
    await enterAddress(context);
    await within(context.canvasElement).findByRole('alert');
  },
};
