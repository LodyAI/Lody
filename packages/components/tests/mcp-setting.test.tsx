// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { TooltipProvider } from '../src/ui/tooltip';
import { McpSetting } from '../src/components/settings/mcp-setting';
import { initI18n } from '../src/i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const catalog = vi.hoisted(() => ({
  servers: Array<WorkspaceMcpServerMeta>(),
  upsert: vi.fn<(entry: WorkspaceMcpServerMeta) => Promise<void>>(),
  requestLocalMcpTools: vi.fn<WorkspaceRuntime['requestLocalMcpTools']>(),
}));
vi.mock('../src/atoms/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/atoms/runtime')>();
  const { atom } = await import('jotai');
  return {
    ...actual,
    activeWorkspaceRuntimeAtom: atom({
      requestLocalMcpTools: catalog.requestLocalMcpTools,
    } satisfies Pick<WorkspaceRuntime, 'requestLocalMcpTools'>),
  };
});
vi.mock('../src/hooks/use-workspace-mcp-catalog', () => ({
  useWorkspaceMcpCatalog: () => ({ servers: catalog.servers, synced: true }),
  useWorkspaceMcpCatalogActions: () => ({ upsert: catalog.upsert, remove: vi.fn() }),
}));
vi.mock('../src/hooks/use-mobile', () => ({ useIsMobile: () => false }));

it.each(['tools', 'empty', 'error'])(
  'only connects the reviewed entry after Save and shows the %s result',
  async (outcome) => {
    await initI18n('en');
    const probes: WorkspaceMcpServerMeta[] = [];
    catalog.servers = [
      {
        id: 'test' as McpServerId,
        name: 'Files',
        transport: 'stdio',
        connection: { transport: 'stdio', command: 'synthetic' },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    let finishSave: () => void = () => {
      throw new Error('Save was not started');
    };
    let durable = false;
    catalog.upsert.mockImplementation(
      (entry: WorkspaceMcpServerMeta) =>
        new Promise<void>((resolve) => {
          finishSave = () => {
            catalog.servers = [entry];
            durable = true;
            resolve();
          };
        })
    );
    const store = createStore();
    store.set(localProbeResultAtom, { ok: true, machineId: 'local' });
    catalog.requestLocalMcpTools.mockImplementation(async (_machineId, server) => {
      probes.push(server);
      if (durable && outcome === 'error') throw new Error('Connection failed');
      return {
        type: 'mcp/tools',
        tools:
          durable && outcome === 'empty'
            ? []
            : [
                {
                  name: durable ? 'saved_tool' : 'existing_tool',
                  description: 'Tool description',
                },
              ],
      };
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <Provider store={store}>
            <TooltipProvider>
              <McpSetting />
            </TooltipProvider>
          </Provider>
        )
      );
      expect(probes).toEqual([]);
      await act(async () => {
        const discover = [...container.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('Load tools')
        );
        if (!discover) throw new Error('Missing Load tools button');
        discover.click();
      });
      expect(probes.map((server) => server.connection)).toEqual([
        { transport: 'stdio', command: 'synthetic' },
      ]);
      expect(container.textContent).toContain('existing_tool');
      probes.length = 0;
      catalog.servers = [
        ...catalog.servers,
        {
          ...catalog.servers[0],
          id: 'unreviewed' as McpServerId,
          name: 'Unreviewed',
          transport: 'stdio',
          connection: { transport: 'stdio', command: 'untrusted-command' },
          createdAt: 1,
          updatedAt: 2,
        },
      ];
      await act(async () =>
        root.render(
          <Provider store={store}>
            <TooltipProvider>
              <McpSetting />
            </TooltipProvider>
          </Provider>
        )
      );
      expect(probes).toEqual([]);
      await act(async () => {
        const edit = [...container.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('Files')
        );
        if (!edit) throw new Error('Missing edit button');
        edit.click();
      });
      await act(async () => {
        const save = document.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (!save) throw new Error('Missing Save button');
        save.click();
      });
      expect(probes).toEqual([]);
      expect(container.textContent).not.toContain('saved_tool');
      await act(async () => finishSave());
      expect(probes.map((server) => server.connection)).toEqual([
        { transport: 'stdio', command: 'synthetic' },
      ]);
      if (outcome === 'tools')
        expect(container.querySelector('[title="Tool description"]')?.textContent).toBe(
          'saved_tool'
        );
      else expect(container.querySelector('[aria-label="Available tools"]')).toBeNull();
      if (outcome === 'error') expect(container.textContent).toContain('Connection failed');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  }
);
