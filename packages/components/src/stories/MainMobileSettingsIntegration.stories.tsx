import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { createStore, Provider } from 'jotai';
import { Toast } from '@lody/ui';
import {
  getMachineRoomId,
  type LocalProjectControlRequest,
  type LocalProjectControlResponse,
  type LocalProjectId,
  type MachineId,
  type MachineViewMeta,
  type WorkspaceId,
} from '@lody/shared';
import { MobileLocalProjectSettings } from '../components/mobile/mobile-local-project-settings';
import { userAtom } from '../atoms';
import { machineMetaCacheAtom } from '../atoms/doc-meta';
import { runtimeAtom, type WorkspaceRuntime } from '../atoms/runtime';
import { setWorkspaceContextAtom } from '../atoms/workspace-context';
import { toastManager } from '../lib/toast';
import { SettingsStoryProviders } from './settings-story-shell';

const workspaceId = 'synthetic-mobile-settings-workspace' as WorkspaceId;
const machineId = 'synthetic-mobile-settings-machine' as MachineId;
const projectId = 'synthetic-mobile-settings-project' as LocalProjectId;
const ownerId = 'synthetic-mobile-settings-owner';
type Mode = 'success' | 'reject' | 'unsupported' | 'non-owner';

function Fixture({ mode }: { mode: Mode }) {
  const [result, setResult] = useState('No deletion requested');
  const [removed, setRemoved] = useState(false);
  const [command, setCommand] = useState('none');
  const [store] = useState(() => {
    const next = createStore();
    const machine: MachineViewMeta = {
      id: machineId,
      name: 'Synthetic project device',
      ownerUserId: ownerId,
      hostType: 'user',
      cliVersion: '1.0.0',
      os: 'darwin',
      sessions: [],
      raceLimits: {},
      protocolCapabilities: mode === 'unsupported' ? {} : { localProjectRemoval: 1 },
      localProjects: {
        [projectId]: {
          id: projectId,
          name: 'Synthetic existing project',
          rootPath: '/synthetic/projects/existing',
          createdAtMs: 1,
        },
      },
    };
    const requestLocalProjectControl = async (
      request: LocalProjectControlRequest
    ): Promise<LocalProjectControlResponse> => {
      if (
        request.type === 'local-project/list-skills' ||
        request.type === 'local-project/list-global-skills'
      ) {
        return {
          ok: true,
          type: request.type,
          result: { groups: [], contentFingerprint: 'empty' },
        };
      }
      if (
        request.type === 'local-project/get-worktree-setup' ||
        request.type === 'local-project/get-worktree-cleanup'
      ) {
        return { ok: true, type: request.type, result: { scripts: {} } };
      }
      throw new Error(`Unexpected synthetic control request: ${request.type}`);
    };
    const runtime = {
      workspaceId,
      workspaceSlug: 'synthetic-mobile-settings',
      contentMode: 'plain',
      requestLocalProjectControl,
      repo: {
        openFlockDoc: async () => ({
          flock: { scan: () => [], subscribe: () => () => undefined },
          syncOnce: async () => ({ ok: true, transports: [{ transportId: 'local', ok: true }] }),
        }),
      },
      writer: {
        flockRowPut: async (docId: string, key: readonly unknown[], value: unknown) => {
          setCommand(JSON.stringify({ docId, key, value }));
          if (mode === 'reject') {
            setResult('Synthetic command rejected; settings remain open');
            throw new Error('Synthetic local-project command rejected');
          }
          setResult('Synthetic command admitted');
        },
      },
    } as unknown as WorkspaceRuntime;
    next.set(userAtom, {
      id: mode === 'non-owner' ? 'synthetic-read-only-member' : ownerId,
      name: 'Synthetic user',
      email: 'fixture@example.com',
      image: null,
    });
    next.set(setWorkspaceContextAtom, {
      workspaceId,
      slug: 'synthetic-mobile-settings',
    });
    next.set(runtimeAtom, runtime);
    next.set(machineMetaCacheAtom, { [getMachineRoomId(machineId)]: machine });
    return next;
  });
  return (
    <Provider store={store}>
      <SettingsStoryProviders>
        <div
          data-main-mobile-settings={mode}
          style={{
            minHeight: '100dvh',
            maxWidth: 640,
            paddingBlock: 16,
            marginInline: 'auto',
            backgroundColor: 'hsl(var(--background))',
            color: 'hsl(var(--foreground))',
          }}
        >
          {!removed ? (
            <MobileLocalProjectSettings
              machineId={machineId}
              projectId={projectId}
              onRemoved={() => {
                setRemoved(true);
                setResult('Navigated after admitted deletion');
              }}
            />
          ) : null}
          <output
            data-main-mobile-settings-result=""
            data-removed={String(removed)}
            style={{ display: 'block', padding: 16, overflowWrap: 'anywhere' }}
          >
            {result}
          </output>
          <output
            data-main-mobile-settings-command=""
            style={{ display: 'block', padding: 16, overflowWrap: 'anywhere', fontSize: 11 }}
          >
            {command}
          </output>
        </div>
        <Toast.Provider manager={toastManager} />
      </SettingsStoryProviders>
    </Provider>
  );
}

const meta = {
  title: 'Mobile/MainMobileSettingsIntegration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const DirectDelete: Story = { render: () => <Fixture mode="success" /> };
export const RejectedDelete: Story = { render: () => <Fixture mode="reject" /> };
export const UnsupportedProtocol: Story = { render: () => <Fixture mode="unsupported" /> };
export const NonOwner: Story = { render: () => <Fixture mode="non-owner" /> };
