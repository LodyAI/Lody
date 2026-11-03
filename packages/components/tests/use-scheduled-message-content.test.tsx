// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleRegistryRow } from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { activeWorkspaceRuntimeAtom } from '../src/atoms/runtime';
import { useScheduledMessageContents } from '../src/components/schedules/use-scheduled-message-content';

const fixtures = vi.hoisted(() => ({
  local: new Map<string, string>(),
  remote: new Map<string, string>(),
  reads: [] as string[],
  syncs: [] as string[][],
}));

vi.mock('@lody/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lody/shared')>();
  return {
    ...actual,
    ScheduleRepository: class {
      async read(scheduleId: string) {
        fixtures.reads.push(scheduleId);
        const text = fixtures.local.get(scheduleId);
        return text ? { message: { inputBlocks: [{ type: 'text', text }] } } : null;
      }
    },
  };
});

vi.mock('../src/atoms/runtime', async () => {
  const { atom } = await import('jotai');
  return { activeWorkspaceRuntimeAtom: atom(null) };
});

vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({ enabled: true, workspaceId: 'workspace-a' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (scheduleId: string, fingerprint = 'a'.repeat(64)): ScheduleRegistryRow =>
  ({
    scheduleId,
    title: 'Stored title',
    ownerId: 'owner',
    machineId: 'machine',
    enabled: true,
    activationId: 'activation',
    activeFrom: 0,
    createdAt: 0,
    updatedAt: 0,
    trigger: { kind: 'once', at: '2026-10-30T09:00:00.000Z' },
    destination: { kind: 'existing_session', sessionId: 'chat' },
    elevatedPermissions: false,
    agentConfigId: 'agent',
    definitionFingerprint: fingerprint,
    scheduledMessage: true,
  }) as ScheduleRegistryRow;

function Host({ rows }: { rows: readonly ScheduleRegistryRow[] }) {
  const contents = useScheduledMessageContents(rows);
  return (
    <div>
      {rows.map((entry) => (
        <span key={entry.scheduleId}>{contents.get(entry.scheduleId) ?? entry.title}</span>
      ))}
    </div>
  );
}

describe('scheduled message content', () => {
  let root: Root;
  let container: HTMLDivElement;
  let runtime: WorkspaceRuntime;
  let sync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fixtures.local.clear();
    fixtures.remote.clear();
    fixtures.reads.length = 0;
    fixtures.syncs.length = 0;
    sync = vi.fn(async (options: { docIds: string[] }) => {
      fixtures.syncs.push(options.docIds);
      for (const docId of options.docIds) {
        const scheduleId = docId.slice('schedule-'.length);
        const text = fixtures.remote.get(scheduleId);
        if (text) fixtures.local.set(scheduleId, text);
      }
      return { ok: true };
    });
    runtime = {
      workspaceId: 'workspace-a',
      contentMode: 'plaintext',
      repo: { sync },
    } as unknown as WorkspaceRuntime;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async (rows: readonly ScheduleRegistryRow[]) => {
    const store = createStore();
    store.set(activeWorkspaceRuntimeAtom, runtime);
    await act(async () => {
      root.render(
        <Provider store={store}>
          <Host rows={rows} />
        </Provider>
      );
    });
  };

  it('uses a local replica without a network sync', async () => {
    fixtures.local.set('one', 'Local message text');
    await render([row('one')]);
    await vi.waitFor(() => expect(container.textContent).toContain('Local message text'));
    expect(fixtures.reads).toEqual(['one']);
    expect(sync).not.toHaveBeenCalled();
  });

  it('pulls a missing document once and shows its text', async () => {
    fixtures.remote.set('remote', 'Fetched message text');
    await render([row('remote')]);
    await vi.waitFor(() => expect(container.textContent).toContain('Fetched message text'));
    expect(fixtures.syncs).toEqual([['schedule-remote']]);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('retries a failed pull when the browser reconnects', async () => {
    sync.mockRejectedValueOnce(new Error('offline'));
    await render([row('offline')]);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(container.textContent).toContain('Stored title');

    fixtures.remote.set('offline', 'After reconnect');
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(container.textContent).toContain('After reconnect'));
  });
});
