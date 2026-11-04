// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { Tooltip } from '@lody/ui/tooltip';
import { McpSetting } from '../src/components/settings/mcp-setting';
import { userAtom } from '../src/atoms';
import { initI18n } from '../src/i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const catalog = vi.hoisted(() => ({
  servers: Array<WorkspaceMcpServerMeta>(),
  upsert: vi.fn<(entry: WorkspaceMcpServerMeta) => Promise<void>>(),
  requestLocalMcpTools: vi.fn<WorkspaceRuntime['requestLocalMcpTools']>(),
  requestLocalMcpAuthentication: vi.fn<WorkspaceRuntime['requestLocalMcpAuthentication']>(
    async () => ({ type: 'mcp/authentication', status: 'unknown', hasCredentials: false })
  ),
  openExternal: vi.fn(async () => true),
}));
vi.mock('../src/lib/native-browser', () => ({ openExternalUrl: catalog.openExternal }));
vi.mock('../src/atoms/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/atoms/runtime')>();
  const { atom } = await import('jotai');
  return {
    ...actual,
    activeWorkspaceRuntimeAtom: atom({
      requestLocalMcpTools: catalog.requestLocalMcpTools,
      requestLocalMcpAuthentication: catalog.requestLocalMcpAuthentication,
    } satisfies Pick<WorkspaceRuntime, 'requestLocalMcpTools' | 'requestLocalMcpAuthentication'>),
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
    store.set(userAtom, { id: 'owner', email: 'owner@example.test', name: 'Owner' });
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
            <Tooltip.Provider>
              <McpSetting />
            </Tooltip.Provider>
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
            <Tooltip.Provider>
              <McpSetting />
            </Tooltip.Provider>
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
      if (outcome === 'empty') expect(container.textContent).toContain('No tools found');
      if (outcome === 'error') expect(container.textContent).toContain('Connection failed');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  }
);

it.each(['cancel', 'close-before-ready', 'manual'] as const)(
  'keeps credentials local and makes authorization explicit (%s)',
  async (scenario) => {
    await initI18n('en');
    catalog.openExternal.mockClear();
    catalog.servers = [
      {
        id: 'remote' as McpServerId,
        name: 'Synthetic remote',
        transport: 'http',
        connection: { transport: 'http', url: 'https://resource.example/mcp' },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const sharedWrites: WorkspaceMcpServerMeta[] = [];
    let privateToken: string | undefined;
    let activeAttempt: string | undefined;
    const pending =
      Promise.withResolvers<
        Awaited<ReturnType<WorkspaceRuntime['requestLocalMcpAuthentication']>>
      >();
    catalog.upsert.mockImplementation(async (entry) => {
      sharedWrites.push(entry);
      catalog.servers = [entry];
    });
    catalog.requestLocalMcpTools.mockImplementation(async () => ({
      type: 'mcp/tools',
      tools: privateToken ? [{ name: 'private_tool' }] : [],
    }));
    catalog.requestLocalMcpAuthentication.mockImplementation(async (_machine, request) => {
      if (request.action === 'configure') {
        privateToken = request.authentication?.bearerToken;
        return { type: 'mcp/authentication', status: 'authorized', hasCredentials: true };
      }
      if (request.action === 'authorize') {
        activeAttempt = 'synthetic-attempt';
        if (scenario === 'close-before-ready') return pending.promise;
        return {
          type: 'mcp/authentication',
          status: 'waiting',
          hasCredentials: false,
          attemptId: activeAttempt,
          authorizationUrl: 'https://issuer.example/authorize?state=synthetic',
        };
      }
      if (request.action === 'cancel' && request.attemptId === activeAttempt)
        activeAttempt = undefined;
      return {
        type: 'mcp/authentication',
        status: 'required',
        hasCredentials: false,
        reason: 'oauth_required',
      };
    });
    const store = createStore();
    store.set(userAtom, { id: 'owner', email: 'owner@example.test', name: 'Owner' });
    store.set(localProbeResultAtom, { ok: true, machineId: 'local' });
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
    const button = (label: string) => {
      const found = [...document.querySelectorAll('button')].find(
        (item) => item.textContent === label
      );
      if (!found) throw new Error(`Missing ${label}`);
      return found;
    };
    try {
      await act(async () =>
        root.render(
          <Provider store={store}>
            <Tooltip.Provider>
              <McpSetting />
            </Tooltip.Provider>
          </Provider>
        )
      );
      expect(catalog.openExternal).not.toHaveBeenCalled();
      await act(async () => button('Settings').click());
      expect(catalog.openExternal).not.toHaveBeenCalled();
      if (scenario === 'manual') {
        await act(async () => button('Manual credentials').click());
        const input = document.querySelector<HTMLInputElement>('input[id$="-token"]');
        if (!input) throw new Error('Missing token input');
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            input,
            'synthetic-private-token'
          );
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(button('Authorize').disabled).toBe(true);
        await act(async () => button('Save configuration').click());
        expect(privateToken).toBe('synthetic-private-token');
        expect(container.textContent).toContain('private_tool');
        expect(catalog.openExternal).not.toHaveBeenCalled();
        await act(async () => button('Settings').click());
        const url = document.querySelector<HTMLInputElement>('input[id$="-url"]');
        if (!url) throw new Error('Missing MCP URL input');
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            url,
            'https://anonymous.example/mcp'
          );
          url.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => button('Save configuration').click());
        expect(sharedWrites.at(-1)?.connection).toEqual({
          transport: 'http',
          url: 'https://anonymous.example/mcp',
        });
      } else {
        await act(async () => button('Authorize').click());
        if (scenario === 'cancel') {
          expect(catalog.openExternal).toHaveBeenCalledWith(
            'https://issuer.example/authorize?state=synthetic'
          );
          await act(async () => button('Cancel').click());
        } else {
          await act(async () => button('Close').click());
          await act(async () =>
            pending.resolve({
              type: 'mcp/authentication',
              status: 'waiting',
              hasCredentials: false,
              attemptId: 'synthetic-attempt',
              authorizationUrl: 'https://issuer.example/authorize?state=synthetic',
            })
          );
          expect(catalog.openExternal).not.toHaveBeenCalled();
        }
        expect(activeAttempt).toBeUndefined();
      }
      expect(sharedWrites[0]?.connection).toEqual({
        transport: 'http',
        url: 'https://resource.example/mcp',
        authentication: 'local',
      });
      expect(JSON.stringify(sharedWrites)).not.toContain('synthetic-private-token');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  }
);
