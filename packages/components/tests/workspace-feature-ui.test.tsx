// @vitest-environment jsdom
import { act, StrictMode } from 'react';
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
import { runtimeAtom } from '../src/atoms/runtime';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import type { SessionAttachmentDraft } from '../src/lib/session-attachment-draft';
import { workspaceSupports } from '@lody/shared/workspace-streams-content';
import type { SessionMeta } from '@lody/shared';
import { useWorkspaceFeature } from '../src/hooks/use-workspace-feature';
import { useCodeCollabRequestedRole } from '../src/hooks/use-code-collab-requested-role';
import { TestCloudPlatformProvider } from './test-platform';

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

it('retains the encrypted scheduled attachment draft when its attachment grant is unavailable', async () => {
  const resources = createSessionSendResources({
    acquire: async () => {
      throw new Error('Unexpected session acquisition');
    },
    releaseRef: () => {},
  });
  const runtime = {
    contentMode: 'e2ee',
    workspaceId: 'workspace',
    sendResources: resources,
  } as WorkspaceRuntime;
  let retained: SessionAttachmentDraft[] = [];
  try {
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
        token: 'synthetic-auth',
        localMachineId: null,
        signal: new AbortController().signal,
        onAttachments: (attachments) => {
          retained = attachments;
        },
      })
    ).rejects.toThrow('e2ee_attachment_unavailable');
    expect(retained[0]).toMatchObject({
      id: 'file',
      name: 'private.txt',
      error: 'e2ee_attachment_unavailable',
    });
    expect(retained[0]?.source).toBeInstanceOf(Blob);
    expect(retained[0]?.ready).toBeUndefined();
  } finally {
    await resources.dispose();
  }
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

it('keeps encrypted Code Collab available while its runtime is starting', async () => {
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
  expect(container.querySelector('output')?.dataset.status).toBe('checking');
  expect(container.querySelector('output')?.dataset.provider).toBe('false');
  expect(container.textContent).not.toContain('Encrypted workspaces do not yet support');
});

it.each([false, true])(
  'keeps unsupported remote provider controls fenced despite signed RPC support (%s)',
  async (protectedRpcAvailable) => {
    const store = encryptedStore();
    store.set(runtimeAtom, {
      contentMode: 'e2ee',
      protectedRpcAvailable,
      accountId: 'user',
      workspaceId: 'workspace',
      workspaceSlug: 'encrypted',
    } as unknown as WorkspaceRuntime);
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
  }
);

it.each(['en', 'zh_CN'])(
  'enables local export controls in encrypted workspaces in %s',
  async (language) => {
    await initI18n(language);
    function ExportControl() {
      const available = useWorkspaceFeature('export');
      return <button disabled={!available}>Export</button>;
    }
    await act(async () =>
      root.render(
        <Provider store={encryptedStore()}>
          <ExportControl />
        </Provider>
      )
    );
    expect(container.querySelector('button')?.disabled).toBe(false);
  }
);

it('takes the encrypted Code Collab role from the verified ledger, not the organization listing', async () => {
  let role: 'read' | 'write' = 'write';
  const listeners = new Set<() => void>();
  const store = encryptedStore();
  store.set(runtimeAtom, {
    contentMode: 'e2ee',
    protectedRpcAvailable: true,
    accountId: 'user',
    workspaceId: 'workspace',
    workspaceSlug: 'encrypted',
    protectedCodeCollabRole: {
      get: () => role,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as WorkspaceRuntime);
  function Role() {
    return <output>{useCodeCollabRequestedRole()}</output>;
  }
  await act(async () =>
    root.render(
      <TestCloudPlatformProvider>
        <Provider store={store}>
          <Role />
        </Provider>
      </TestCloudPlatformProvider>
    )
  );
  expect(container.textContent).toBe('write');
  role = 'read';
  await act(async () => listeners.forEach((listener) => listener()));
  expect(container.textContent).toBe('read');
});

it('shares a scheduled draft through observer replacement and preserves it after remount', async () => {
  const store = createStore();
  const session = { id: 'scheduled-observer-replacement' } as SessionMeta;
  const at = '2030-01-01T12:00:00.000Z';
  function Draft({ label }: { label: string }) {
    const state = useScheduledMessageDraft(session, null);
    return (
      <div data-observer={label}>
        <output>
          {state.at ?? 'empty'}:{String(state.saving)}
        </output>
        <button
          onClick={() => {
            state.apply(at);
            state.setSaving(true);
          }}
        >
          Set draft
        </button>
      </div>
    );
  }
  const renderObservers = (first: boolean, second: boolean) =>
    act(async () =>
      root.render(
        <StrictMode>
          <Provider store={store}>
            {first ? <Draft key="first" label="first" /> : null}
            {second ? <Draft key="second" label="second" /> : null}
          </Provider>
        </StrictMode>
      )
    );
  await renderObservers(true, true);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-observer="first"] button')!.click()
  );
  expect([...container.querySelectorAll('output')].map((node) => node.textContent)).toEqual([
    `${at}:true`,
    `${at}:true`,
  ]);
  await renderObservers(false, true);
  await renderObservers(true, true);
  expect([...container.querySelectorAll('output')].map((node) => node.textContent)).toEqual([
    `${at}:true`,
    `${at}:true`,
  ]);
  await renderObservers(false, false);
  await renderObservers(true, false);
  expect(container.querySelector('output')!.textContent).toBe(`${at}:false`);
});
