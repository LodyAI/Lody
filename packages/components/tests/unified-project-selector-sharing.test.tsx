// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONVEX_AUTH_ERROR_CODE,
  CONVEX_AUTH_ERROR_KIND,
  type LocalProjectId,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';

import { UnifiedProjectSelector } from '../src/components/chat/unified-project-selector';
import type { LocalProjectVisibilityAccess } from '../src/lib/visible-local-project-index';
import type { MachineVisibilityAccess } from '../src/lib/visible-machine-index';
import { Tooltip } from '@lody/ui/tooltip';

const mocks = vi.hoisted(() => ({
  requestAuthRecovery: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  useVisibleLocalProjects: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, values?: Record<string, unknown>) => {
      let message = fallback ?? key;
      for (const [name, value] of Object.entries(values ?? {})) {
        message = message.replace(`{{${name}}}`, String(value));
      }
      return message;
    },
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ requestAuthRecovery: mocks.requestAuthRecovery }),
}));

vi.mock('@/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjects: mocks.useVisibleLocalProjects,
}));
vi.mock('../src/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjects: mocks.useVisibleLocalProjects,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;
const localProjectId = 'project-1' as LocalProjectId;
const projectKey = `${machineId}:${localProjectId}`;

const machine: MachineViewMeta = {
  id: machineId,
  name: 'Workstation',
  ownerUserId: 'owner-user',
  cliVersion: '',
  os: '',
  sessions: [],
  raceLimits: {},
  localProjects: {
    [localProjectId]: {
      id: localProjectId,
      name: 'Lody',
      rootPath: '/work/lody',
      createdAtMs: 1,
    },
  },
};

const machineAccess: MachineVisibilityAccess = {
  machineId,
  ownerUserId: 'owner-user',
  sharedWithTeam: true,
  updatedAt: 1,
};

function createVisibleProjects({
  includeProjectAccess = true,
  isLoading = false,
  projectSharedWithTeam = false,
}: {
  includeProjectAccess?: boolean;
  isLoading?: boolean;
  projectSharedWithTeam?: boolean;
} = {}) {
  const project = machine.localProjects![localProjectId]!;
  const projectAccess: LocalProjectVisibilityAccess = {
    machineId,
    localProjectId,
    ownerUserId: 'owner-user',
    sharedWithTeam: projectSharedWithTeam,
    updatedAt: 1,
  };

  return {
    projects: new Map([
      [
        projectKey,
        {
          key: projectKey,
          machineId,
          machine,
          project,
          isMachineRegistered: true,
        },
      ],
    ]),
    accessByProjectKey: includeProjectAccess ? new Map([[projectKey, projectAccess]]) : new Map(),
    accessByMachineId: new Map(),
    isLoading,
  };
}

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

describe('UnifiedProjectSelector project sharing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useVisibleLocalProjects.mockReturnValue(createVisibleProjects());
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  async function renderSelector({
    currentUserId = 'owner-user',
    onShareWithTeam = vi.fn(async () => {}),
    includeProjectSharing = true,
  }: {
    currentUserId?: string | null;
    onShareWithTeam?: (selection: {
      machineId: MachineId;
      localProjectId: LocalProjectId;
    }) => Promise<void>;
    includeProjectSharing?: boolean;
  } = {}) {
    await act(async () => {
      root.render(
        <Tooltip.Provider>
          <UnifiedProjectSelector
            value={{ kind: 'local', machineId, localProjectId }}
            onChange={vi.fn()}
            selectedMachineId={machineId}
            onAddLocalProject={vi.fn()}
            onConnectGitRepo={vi.fn()}
            projectSharing={
              includeProjectSharing
                ? {
                    currentUserId,
                    machineAccessByMachineId: new Map([[machineId, machineAccess]]),
                    onShareWithTeam,
                  }
                : undefined
            }
          />
        </Tooltip.Provider>
      );
    });
    return onShareWithTeam;
  }

  function getShareTrigger(): HTMLButtonElement | null {
    return document.querySelector('button[aria-label*="Share project"]');
  }

  function getProjectPickerTrigger(): HTMLButtonElement {
    const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Lody'
    );
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    return trigger!;
  }

  async function openProjectMenu() {
    await act(async () => {
      getProjectPickerTrigger().dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 })
      );
      // Base UI schedules the open in an animation frame.
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }

  function getProjectMenuItem(): HTMLElement {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (menuItem) => menuItem.textContent?.includes('Lody')
    );
    expect(item).toBeInstanceOf(HTMLElement);
    return item!;
  }

  async function confirmShare() {
    const shareTrigger = getShareTrigger();
    expect(shareTrigger).toBeInstanceOf(HTMLButtonElement);

    await act(async () => shareTrigger?.click());

    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    const action = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Share project'
    );
    expect(action).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      action?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('shows Private on both the selected project and its dropdown option', async () => {
    await renderSelector();

    expect(getShareTrigger()?.textContent).toContain('Private');
    expect(getProjectPickerTrigger().className).toContain('rounded-r-none');

    await openProjectMenu();

    expect(getProjectMenuItem().textContent).toContain('Private');
  });

  it('shares an owner-private project, closes the dialog, and shows success', async () => {
    const onShareWithTeam = vi.fn(async () => {});
    await renderSelector({ onShareWithTeam });

    await confirmShare();

    expect(onShareWithTeam).toHaveBeenCalledWith(
      expect.objectContaining({ machineId, localProjectId })
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('“Lody” is now shared with the team');
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('recovers an unauthenticated rejection without exposing Convex details', async () => {
    const authError = new ConvexError({
      kind: CONVEX_AUTH_ERROR_KIND,
      code: CONVEX_AUTH_ERROR_CODE.unauthenticated,
    });
    const onShareWithTeam = vi.fn(() => Promise.reject(authError));
    await renderSelector({ onShareWithTeam });

    await confirmShare();

    expect(mocks.requestAuthRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to update project sharing', {
      description: 'Refreshing your session. Please try again in a moment.',
    });
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain('[CONVEX');
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  });

  it.each([
    {
      name: 'visibility is unknown',
      visibleProjects: createVisibleProjects({ includeProjectAccess: false, isLoading: true }),
      includeProjectSharing: true,
    },
    {
      name: 'the project is shared with the team',
      visibleProjects: createVisibleProjects({ projectSharedWithTeam: true }),
      includeProjectSharing: true,
    },
    {
      name: 'sharing context is omitted for a single-member workspace',
      visibleProjects: createVisibleProjects(),
      includeProjectSharing: false,
    },
  ])('hides the sharing status when $name', async ({ visibleProjects, includeProjectSharing }) => {
    mocks.useVisibleLocalProjects.mockReturnValue(visibleProjects);

    await renderSelector({ includeProjectSharing });

    expect(getShareTrigger()).toBeNull();
    expect(getProjectPickerTrigger().className).not.toContain('rounded-r-none');

    await openProjectMenu();

    expect(getProjectMenuItem().textContent).not.toMatch(/Private|Team|Checking/);
  });

  it('shows Private without a share action to a non-owner', async () => {
    const onShareWithTeam = vi.fn(async () => {});

    await renderSelector({ currentUserId: 'teammate-user', onShareWithTeam });

    expect(getShareTrigger()).toBeNull();
    expect(getProjectPickerTrigger().className).toContain('rounded-r-none');
    expect(document.body.textContent).toContain('Private');
    expect(onShareWithTeam).not.toHaveBeenCalled();
  });
});
