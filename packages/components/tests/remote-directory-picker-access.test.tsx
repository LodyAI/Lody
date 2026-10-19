// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineId } from '@lody/shared';
import {
  RemoteDirectoryPicker,
  type RemoteDirectoryOps,
  type RemoteDirectoryPickerMachine,
} from '../src/components/local-projects/add-local-project-dialog';
import { initI18n } from '../src/i18n';
import { MobileAddLocalProjectFlow } from '../src/components/local-projects/mobile-add-local-project-flow';

const ownMachineId = 'machine-own' as MachineId;
const teammateMachineId = 'machine-team' as MachineId;

const machines: RemoteDirectoryPickerMachine[] = [
  {
    id: ownMachineId,
    name: 'My Mac',
    online: true,
    ownerName: 'Zoe',
    canAddProjects: true,
    supportsCreateDirectory: true,
  },
  {
    id: teammateMachineId,
    name: 'Build server',
    online: true,
    ownerName: 'Alex Chen',
    canAddProjects: false,
  },
];

function findMachineButton(name: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(name)
  );
  if (!button) throw new Error(`Expected machine button for ${name}`);
  return button;
}

function createOps() {
  const listRoots = vi.fn<RemoteDirectoryOps['listRoots']>(async () => ({
    ok: true,
    value: { platform: 'darwin', pathSeparator: '/', homeDir: '/Users/zoe' },
  }));
  const browseDir = vi.fn<RemoteDirectoryOps['browseDir']>(async () => ({
    ok: true,
    value: {
      path: '/Users/zoe',
      parentPath: null,
      entries: [],
      truncated: false,
    },
  }));
  const ops: RemoteDirectoryOps = {
    listRoots,
    browseDir,
    createDirectory: async () => ({ ok: false, message: 'Unexpected create' }),
    addProject: vi.fn(),
  };
  return { listRoots, browseDir, ops };
}

describe('RemoteDirectoryPicker machine ownership', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each([RemoteDirectoryPicker, MobileAddLocalProjectFlow])(
    'offers a keyboard-accessible create form and then adds the new path (%#)',
    async (Picker) => {
      const { ops } = createOps();
      const created: string[] = [];
      const added: string[] = [];
      ops.browseDir = async (_id, args) => ({
        ok: true,
        value: { path: args.absolutePath!, parentPath: '/Users', entries: [], truncated: false },
      });
      ops.createDirectory = async (_id, args) => {
        const target = `${args.parentPath}/${args.name}`;
        created.push(target);
        return { ok: true, value: { path: target } };
      };
      ops.addProject = async (_id, args) => {
        added.push(args.rootPath);
        return { ok: false, message: 'Synthetic registration failure' };
      };
      await act(async () =>
        root?.render(
          <Picker
            machines={machines}
            initialMachineId={ownMachineId}
            ops={ops}
            onAdded={vi.fn()}
            onClose={vi.fn()}
          />
        )
      );
      const button = (name: string) => {
        const value = Array.from(container!.querySelectorAll('button')).find(
          (el) => el.textContent === name
        );
        if (!value) throw new Error(`Missing ${name} button`);
        return value;
      };
      await act(async () => button('New folder').click());
      const input = container!.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!;
      expect(document.activeElement).toBe(input);
      expect(button('Create').disabled).toBe(true);
      expect(button('Add').disabled).toBe(true);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          'new'
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(button('Create').disabled).toBe(false);
      await act(async () => {
        container!
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(created).toEqual(['/Users/zoe/new']);
      expect(added).toEqual([]);
      expect(container!.querySelector('form')).toBeNull();
      expect(button('Add').disabled).toBe(false);
      await act(async () => button('Add').click());
      expect(added).toEqual(['/Users/zoe/new']);
      expect(container!.textContent).toContain('Synthetic registration failure');
    }
  );

  it('hides creation for an older daemon while retaining Add', async () => {
    const { ops } = createOps();
    await act(async () =>
      root?.render(
        <RemoteDirectoryPicker
          machines={[{ ...machines[0], supportsCreateDirectory: false }]}
          initialMachineId={ownMachineId}
          ops={ops}
          onAdded={vi.fn()}
          onClose={vi.fn()}
        />
      )
    );
    expect(container!.textContent).not.toContain('New folder');
    expect(
      Array.from(container!.querySelectorAll('button')).find((el) => el.textContent === 'Add')
        ?.disabled
    ).toBe(false);
  });

  it.each([
    ['already_exists', 'A file or folder with this name already exists.'],
    [
      'execution_failed',
      "Can't confirm creation. Reconnect and refresh the parent folder before retrying.",
    ],
  ])('renders %s and retains the editable name', async (errorCode, message) => {
    const { ops } = createOps();
    ops.createDirectory = async () => ({
      ok: false,
      errorCode,
      message: 'Synthetic failure',
    });
    await act(async () =>
      root?.render(
        <RemoteDirectoryPicker
          machines={machines}
          initialMachineId={ownMachineId}
          ops={ops}
          onAdded={vi.fn()}
          onClose={vi.fn()}
        />
      )
    );
    await act(async () =>
      Array.from(container!.querySelectorAll('button'))
        .find((el) => el.textContent === 'New folder')!
        .click()
    );
    const input = container!.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'existing'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container!
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(input.value).toBe('existing');
    expect(input.disabled).toBe(false);
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(message);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container!.querySelector('form')).toBeNull();
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it('explains teammate ownership without sending a browse request', async () => {
    const { listRoots, browseDir, ops } = createOps();

    await act(async () => {
      root?.render(
        <RemoteDirectoryPicker machines={machines} ops={ops} onAdded={vi.fn()} onClose={vi.fn()} />
      );
    });

    await act(async () => {
      findMachineButton('Build server').click();
    });

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'This machine belongs to Alex Chen'
    );
    expect(listRoots).not.toHaveBeenCalled();
    expect(browseDir).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Choose a machine');

    await act(async () => {
      findMachineButton('My Mac').click();
    });

    expect(listRoots).toHaveBeenCalledWith(ownMachineId);
    expect(browseDir).toHaveBeenCalledWith(ownMachineId, {
      absolutePath: '/Users/zoe',
    });
  });

  it('does not auto-browse a teammate machine supplied as the initial selection', async () => {
    const { listRoots, browseDir, ops } = createOps();

    await act(async () => {
      root?.render(
        <RemoteDirectoryPicker
          machines={machines}
          initialMachineId={teammateMachineId}
          ops={ops}
          onAdded={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });

    expect(listRoots).not.toHaveBeenCalled();
    expect(browseDir).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Choose a machine');
  });

  it('shows a loading state while ownership identity is unresolved', async () => {
    const { ops } = createOps();

    await act(async () => {
      root?.render(
        <RemoteDirectoryPicker
          machines={[]}
          machinesLoading
          ops={ops}
          onAdded={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });

    expect(document.body.textContent).toContain('Loading machines');
    expect(document.body.textContent).not.toContain('No machines available');
  });
});
