// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';

import {
  type RemoteDirectoryOps,
  type RemoteDirectoryPickerController,
  type RemoteDirectoryPickerMachine,
  useRemoteDirectoryPicker,
} from '../src/components/local-projects/use-remote-directory-picker';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;
const registeredProjectId = 'project-1' as LocalProjectId;
const registeredPath = '/home/user/project';

describe('useRemoteDirectoryPicker directory navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: RemoteDirectoryPickerController | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const ownMachine: RemoteDirectoryPickerMachine = {
    id: machineId,
    name: 'Machine',
    online: true,
    ownerName: null,
    canAddProjects: true,
    supportsCreateDirectory: true,
  };
  function setup(overrides: Partial<RemoteDirectoryOps> = {}) {
    const created: string[] = [];
    const added: string[] = [];
    const onAdded = vi.fn();
    const onClose = vi.fn();
    const ops: RemoteDirectoryOps = {
      listRoots: async () => ({
        ok: true,
        value: { platform: 'linux', pathSeparator: '/', homeDir: '/home/user' },
      }),
      browseDir: async (_id, args) => ({
        ok: true,
        value: {
          path: args.absolutePath ?? '/home/user',
          parentPath: '/home',
          entries: [],
          truncated: false,
        },
      }),
      createDirectory: async (_id, args) => {
        const target = `${args.parentPath}/${args.name}`;
        if (created.includes(target))
          return { ok: false, errorCode: 'already_exists', message: 'Exists' };
        created.push(target);
        return { ok: true, value: { path: target } };
      },
      addProject: async (_id, args) => {
        added.push(args.rootPath);
        return {
          ok: true,
          value: {
            status: 'added',
            localProjectId: registeredProjectId,
            name: 'new',
            rootPath: args.rootPath,
          },
        };
      },
      ...overrides,
    };
    function Probe({ machines }: { machines: RemoteDirectoryPickerMachine[] }) {
      controller = useRemoteDirectoryPicker({
        machines,
        initialMachineId: machineId,
        ops,
        onAdded,
        onClose,
      });
      return null;
    }
    const render = async (machines = [ownMachine]) => {
      await act(async () =>
        root.render(
          <StrictMode>
            <Probe machines={machines} />
          </StrictMode>
        )
      );
    };
    const nameFolder = async (name = 'new') => {
      await act(async () => controller!.startNewFolder());
      await act(async () => controller!.setFolderName(name));
    };
    return { created, added, onAdded, onClose, render, nameFolder, ops };
  }

  it('creates under the current directory, enters it, and registers only on Add', async () => {
    const h = setup();
    await h.render();
    await act(async () => controller!.navigate('/home/user/projects'));
    await h.nameFolder();
    expect(controller!.canAddCurrentFolder).toBe(false);
    await act(async () => {
      await controller!.addCurrentFolder();
      await controller!.createFolder();
    });
    expect(h.created).toEqual(['/home/user/projects/new']);
    expect(h.added).toEqual([]);
    expect(controller!.current?.path).toBe('/home/user/projects/new');
    expect(controller!.newFolderOpen).toBe(false);
    expect(controller!.canAddCurrentFolder).toBe(true);
    expect(h.onClose).not.toHaveBeenCalled();
    await act(async () => controller!.addCurrentFolder());
    expect(h.added).toEqual(['/home/user/projects/new']);
    expect(h.onAdded).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: '/home/user/projects/new' })
    );
  });

  it.each([
    'access_denied',
    'path_invalid',
    'already_exists',
    'daemon_unavailable',
    'timeout',
    'execution_failed',
  ])('preserves the parent and name on %s and permits correction', async (errorCode) => {
    const h = setup({
      createDirectory: async () => ({ ok: false, errorCode, message: 'Synthetic failure' }),
    });
    await h.render();
    await h.nameFolder();
    await act(async () => controller!.createFolder());
    expect(controller!.current?.path).toBe('/home/user');
    expect(controller!.folderName).toBe('new');
    expect(controller!.newFolderOpen).toBe(true);
    expect(controller!.creating).toBe(false);
    expect(controller!.createError?.code).toBe(errorCode);
    expect(h.created).toEqual([]);
    expect(h.added).toEqual([]);
  });

  it('recovers from a rejected transport promise', async () => {
    const h = setup({
      createDirectory: async () => {
        throw new Error('disconnected');
      },
    });
    await h.render();
    await h.nameFolder();
    await act(async () => controller!.createFolder());
    expect(controller!.createError?.code).toBe('daemon_unavailable');
    expect(controller!.folderName).toBe('new');
    expect(controller!.canCreateFolder).toBe(true);
    expect(h.added).toEqual([]);
  });

  it('does not send creation while offline, unsupported, unauthorized or with an invalid name', async () => {
    const h = setup();
    await h.render();
    await h.nameFolder('../escape');
    await act(async () => controller!.createFolder());
    expect(controller!.createError?.code).toBe('invalid_request');
    await act(async () => controller!.setFolderName('new'));
    for (const patch of [
      { online: false },
      { supportsCreateDirectory: false },
      { canAddProjects: false },
    ]) {
      await h.render([{ ...ownMachine, ...patch }]);
      await act(async () => controller!.createFolder());
      expect(controller!.canCreateFolder).toBe(false);
      expect(h.created).toEqual([]);
    }
    await h.render();
    await act(async () => controller!.createFolder());
    expect(h.created).toEqual(['/home/user/new']);
  });

  it('serializes same-tick Create and Add attempts until browsing finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup();
    const create = h.ops.createDirectory;
    h.ops.createDirectory = async (...args) => {
      await gate;
      return create(...args);
    };
    await h.render();
    await h.nameFolder();
    let pending!: Promise<void>;
    await act(async () => {
      pending = controller!.createFolder();
      void controller!.createFolder();
      void controller!.addCurrentFolder();
    });
    expect(controller!.creating).toBe(true);
    expect(controller!.canAddCurrentFolder).toBe(false);
    await act(async () => {
      release();
      await pending;
    });
    expect(h.created).toEqual(['/home/user/new']);
    expect(h.added).toEqual([]);
    expect(controller!.current?.path).toBe('/home/user/new');
  });

  it.each(['navigate', 'back', 'close'] as const)(
    'ignores creation completion after %s',
    async (action) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = setup();
      const create = h.ops.createDirectory;
      h.ops.createDirectory = async (...args) => {
        await gate;
        return create(...args);
      };
      await h.render();
      await h.nameFolder();
      let pending!: Promise<void>;
      await act(async () => {
        pending = controller!.createFolder();
      });
      await act(async () => {
        if (action === 'navigate') controller!.navigate('/elsewhere');
        else controller![action]();
      });
      await act(async () => {
        release();
        await pending;
      });
      expect(h.created).toEqual(['/home/user/new']);
      expect(controller!.current?.path).not.toBe('/home/user/new');
      expect(h.added).toEqual([]);
      if (action === 'navigate') expect(controller!.current?.path).toBe('/elsewhere');
      if (action === 'back') expect(controller!.phase).toBe('machine');
    }
  );

  it('retries browsing the created directory without repeating mkdir after a browse failure', async () => {
    const h = setup();
    const browse = h.ops.browseDir;
    h.ops.browseDir = async (id, args) =>
      args.absolutePath?.endsWith('/new')
        ? { ok: false, errorCode: 'daemon_unavailable', message: 'offline' }
        : browse(id, args);
    await h.render();
    await h.nameFolder();
    await act(async () => controller!.createFolder());
    expect(controller!.current?.path).toBe('/home/user/new');
    expect(controller!.status).toBe('error');
    expect(controller!.newFolderOpen).toBe(false);
    h.ops.browseDir = browse;
    await act(async () => controller!.retry());
    expect(controller!.status).toBe('ready');
    expect(h.created).toEqual(['/home/user/new']);
    expect(h.added).toEqual([]);
  });

  it('browses into an already registered project instead of closing the picker', async () => {
    const onClose = vi.fn();
    const browseDir = vi.fn<RemoteDirectoryOps['browseDir']>(async (_machineId, args) => ({
      ok: true,
      value: {
        path: args.absolutePath ?? '/home/user',
        parentPath: null,
        entries:
          args.absolutePath === registeredPath
            ? []
            : [
                {
                  name: 'project',
                  absolutePath: registeredPath,
                  isSymlink: false,
                  hidden: false,
                  registeredProjectId,
                },
              ],
        truncated: false,
      },
    }));
    const ops: RemoteDirectoryOps = {
      listRoots: async () => ({
        ok: true,
        value: { platform: 'linux', pathSeparator: '/', homeDir: '/home/user' },
      }),
      browseDir,
      createDirectory: async () => ({ ok: false, message: 'Unexpected create' }),
      addProject: async () => {
        throw new Error('Unexpected add');
      },
    };

    function Probe() {
      controller = useRemoteDirectoryPicker({
        machines: [
          {
            id: machineId,
            name: 'Machine',
            online: true,
            ownerName: null,
            canAddProjects: true,
          },
        ],
        initialMachineId: machineId,
        ops,
        onAdded: vi.fn(),
        onClose,
      });
      return null;
    }

    await act(async () => root.render(<Probe />));

    const registeredEntry = controller?.current?.entries[0];
    expect(registeredEntry?.registeredProjectId).toBe(registeredProjectId);

    await act(async () => {
      if (!registeredEntry) throw new Error('Registered project entry was not loaded');
      controller?.entryClick(registeredEntry);
    });

    expect(browseDir).toHaveBeenLastCalledWith(machineId, { absolutePath: registeredPath });
    expect(controller?.current?.path).toBe(registeredPath);
    expect(onClose).not.toHaveBeenCalled();
  });
});
