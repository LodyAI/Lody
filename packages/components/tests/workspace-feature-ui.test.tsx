// @vitest-environment jsdom
import { act } from 'react';
import { Provider, createStore } from 'jotai';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { useScheduledMessageDraft } from '../src/components/schedules/use-scheduled-message';
import { useCodeCollabSessionFileProvider } from '../src/hooks/use-code-collab-session-file-provider';
import {
  MachineDetailPane,
  MachineProvidersSection,
} from '../src/components/settings/machine-detail-pane';
import { LoroRepo } from 'loro-repo';
import { ScheduleRepository, type WorkspaceId } from '@lody/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import {
  SessionStatusStrip,
  resolveSessionStatusStripState,
} from '../src/components/sessions/session-status-strip';
import {
  prepareScheduledMessage,
  saveScheduledMessage,
} from '../src/components/schedules/scheduled-message-write';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { workspaceSupports } from '@lody/shared/workspace-streams-content';
import type { SessionMeta } from '@lody/shared';
import { useWorkspaceFeature } from '../src/hooks/use-workspace-feature';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  await initI18n('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it.each(['en', 'zh_CN'])(
  'enables encrypted presence without the unavailable notice in %s',
  async (language) => {
    await initI18n(language);
    function PresenceStatus() {
      const available = useWorkspaceFeature('presence');
      return (
        <SessionStatusStrip
          state={resolveSessionStatusStripState({
            browserOnline: true,
            machineRemoved: false,
            machineOnlineStatus: 'unknown',
            presenceAvailable: available,
          })}
        />
      );
    }
    expect(workspaceSupports({ mode: 'protected' }, 'presence')).toBe(true);
    await act(async () =>
      root.render(
        <Provider store={encryptedStore()}>
          <PresenceStatus />
        </Provider>
      )
    );
    expect(container.textContent).toBe('');
  }
);

it('keeps ordinary unknown presence silent', async () => {
  const state = resolveSessionStatusStripState({
    browserOnline: true,
    machineRemoved: false,
    machineOnlineStatus: 'unknown',
  });
  await act(async () => root.render(<SessionStatusStrip state={state} />));
  expect(container.textContent).toBe('');
});

it('prepares and saves an encrypted scheduled message through the ordinary repository', async () => {
  const repo = await LoroRepo.create({});
  const workspaceId = 'workspace' as WorkspaceId;
  const runtime = {
    contentMode: 'e2ee',
    workspaceId,
    repo,
    withScheduleStore: async (_id: string, write: () => Promise<unknown>) => write(),
  } as WorkspaceRuntime;
  try {
    const message = await prepareScheduledMessage({
      runtime,
      sessionId: 'session' as never,
      machineId: 'machine' as never,
      actorId: 'owner',
      inputBlocks: [{ type: 'text', text: 'hello' }],
      attachments: [],
      token: null,
      localMachineId: null,
      signal: new AbortController().signal,
      onAttachments: () => {},
    });
    await saveScheduledMessage({
      runtime,
      actorId: 'owner',
      scheduleId: 'reserved',
      activationId: 'activation',
      activityId: 'activity',
      create: true,
      now: 100,
      draft: {
        title: 'Hello',
        prompt: 'hello',
        message,
        trigger: { kind: 'once', at: new Date(1000).toISOString() },
        destination: { kind: 'existing_session', sessionId: 'session' },
        machineId: 'machine',
        agent: { agentConfigId: 'agent' },
        misfirePolicy: { kind: 'run_once' },
        overlapPolicy: 'queue_one',
        retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
      },
    });
    const repository = new ScheduleRepository(repo, workspaceId);
    expect((await repository.read('reserved'))?.message).toEqual(message);
    expect((await repository.list()).map((row) => row.scheduleId)).toEqual(['reserved']);
  } finally {
    await repo.destroy();
  }
});

it('refuses encrypted scheduled attachment preparation before transferring source bytes', async () => {
  const runtime = { contentMode: 'e2ee' } as WorkspaceRuntime;
  await expect(
    prepareScheduledMessage({
      runtime,
      sessionId: 'session' as never,
      machineId: 'machine' as never,
      actorId: 'owner',
      inputBlocks: [],
      attachments: [
        {
          id: 'file',
          kind: 'file',
          source: new Blob(['private source']),
          name: 'private.txt',
          mimeType: 'text/plain',
          lastModified: 0,
        },
      ],
      token: null,
      localMachineId: null,
      signal: new AbortController().signal,
      onAttachments: () => {},
    })
  ).rejects.toThrow('Encrypted workspaces do not yet support attachments.');
});

function encryptedStore() {
  const store = createStore();
  store.set(workspaceContentModeAtom, {
    accountId: 'user',
    workspaceSlug: 'encrypted',
    workspaceId: 'workspace',
    descriptor: { contentMode: 'e2ee', contentModeVersion: 1 },
  } as never);
  return store;
}

it('keeps the ordinary workspace readiness error for encrypted scheduled messages', async () => {
  function DraftStatus() {
    const state = useScheduledMessageDraft({ id: 'session' } as SessionMeta, null);
    return <button disabled={!!state.disabledReason}>{state.disabledReason}</button>;
  }
  await act(async () =>
    root.render(
      <Provider store={encryptedStore()}>
        <DraftStatus />
      </Provider>
    )
  );
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(container.textContent).toBe('Wait for the workspace to finish loading.');
});

it('renders a Code Collab restriction instead of an endless loading state', async () => {
  function FileStatus() {
    const state = useCodeCollabSessionFileProvider({
      sessionId: 'session',
      machineId: 'remote',
      enabled: true,
    });
    return (
      <output data-status={state.status} data-provider={!!state.provider}>
        {state.message}
      </output>
    );
  }
  await act(async () =>
    root.render(
      <Provider store={encryptedStore()}>
        <FileStatus />
      </Provider>
    )
  );
  expect(container.querySelector('output')?.dataset.status).toBe('unavailable');
  expect(container.querySelector('output')?.dataset.provider).toBe('false');
  expect(container.textContent).toBe('Encrypted workspaces do not yet support Code Collab.');
});

it('hides remote machine controls and provider forms with the same explanation', async () => {
  const store = encryptedStore();
  store.set(localProbeResultAtom, { ok: true, machineId: 'local' });
  const machine = { id: 'remote', name: 'Remote machine' };
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MachineDetailPane {...({ machine, isLocal: false } as never)} />
        <MachineProvidersSection {...({ machine } as never)} />
      </Provider>
    )
  );
  const notices = [...container.querySelectorAll('[role="status"]')];
  expect(notices.map((item) => item.textContent)).toEqual(
    Array(2).fill('Encrypted workspaces do not yet support remote machine operations.')
  );
  expect(container.querySelector('button')).toBeNull();
});
