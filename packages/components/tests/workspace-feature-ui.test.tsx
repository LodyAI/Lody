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
import { SchedulesWorkspace } from '../src/components/schedules/schedules-workspace';
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
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { useWorkspaceFeature } from '../src/hooks/use-workspace-feature';
import type { SessionMeta } from '@lody/shared';

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

it.each(['en', 'zh_CN'])('explains unavailable encrypted presence in %s', async (language) => {
  await initI18n(language);
  const state = resolveSessionStatusStripState({
    browserOnline: true,
    machineRemoved: false,
    machineOnlineStatus: 'offline',
    presenceAvailable: false,
  });
  await act(async () => root.render(<SessionStatusStrip state={state} />));
  expect(container.textContent).toBe(
    language === 'en'
      ? 'Encrypted workspaces do not yet provide online status.'
      : '加密工作区暂不提供在线状态'
  );
});

it('keeps ordinary unknown presence silent', async () => {
  const state = resolveSessionStatusStripState({
    browserOnline: true,
    machineRemoved: false,
    machineOnlineStatus: 'unknown',
  });
  await act(async () => root.render(<SessionStatusStrip state={state} />));
  expect(container.textContent).toBe('');
});

it('refuses schedule preparation and writes with the specific reason before resources are touched', async () => {
  const runtime = { contentMode: 'e2ee' } as WorkspaceRuntime;
  await expect(prepareScheduledMessage({ runtime } as never)).rejects.toThrow(
    'Encrypted workspaces do not yet support scheduled messages.'
  );
  await expect(saveScheduledMessage({ runtime } as never)).rejects.toThrow(
    'Encrypted workspaces do not yet support scheduled messages.'
  );
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

it('shows the schedule restriction before readiness, machine or save errors', async () => {
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
  expect(container.textContent).toBe('Encrypted workspaces do not yet support scheduled messages.');
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

it('blocks a schedule deep link before mounting its editor', async () => {
  await act(async () =>
    root.render(
      <Provider store={encryptedStore()}>
        <SchedulesWorkspace scheduleId="old-link" />
      </Provider>
    )
  );
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Encrypted workspaces do not yet support scheduled messages.'
  );
  expect(container.querySelector('button')).toBeNull();
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

it('removes the unsupported-presence notice only for the matching capable encrypted runtime', async () => {
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
  const store = encryptedStore();
  const capable = {
    workspaceId: 'workspace',
    accountId: 'user',
    presenceAvailable: true,
  } as WorkspaceRuntime;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <PresenceStatus />
      </Provider>
    )
  );
  expect(container.textContent).toBe('Encrypted workspaces do not yet provide online status.');
  await act(async () => {
    store.set(runtimeAtom, capable);
  });
  expect(container.textContent).toBe('');
  await act(async () => {
    store.set(runtimeAtom, { ...capable, presenceAvailable: false });
  });
  expect(container.textContent).toBe('Encrypted workspaces do not yet provide online status.');
  await act(async () => {
    store.set(runtimeAtom, { ...capable, accountId: 'another-account' });
  });
  expect(container.textContent).toBe('Encrypted workspaces do not yet provide online status.');
});
