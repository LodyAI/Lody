// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';

import {
  type RemoteDirectoryOps,
  type RemoteDirectoryPickerController,
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
