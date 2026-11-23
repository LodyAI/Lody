/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';

const mocks = vi.hoisted(() => ({
  teamSharing: true,
}));

vi.mock('../src/lib/app-platform', () => ({
  useAppCapability: () => mocks.teamSharing,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      _key: string,
      fallbackOrOptions?: string | { defaultValue?: string; [key: string]: unknown },
      params?: Record<string, unknown>
    ) => {
      let text =
        typeof fallbackOrOptions === 'string'
          ? fallbackOrOptions
          : (fallbackOrOptions?.defaultValue ?? _key);
      const values =
        params ?? (typeof fallbackOrOptions === 'object' ? fallbackOrOptions : undefined);
      if (values) {
        for (const [k, v] of Object.entries(values)) {
          if (k !== 'defaultValue') {
            text = text.replaceAll(`{{${k}}}`, String(v));
          }
        }
      }
      return text;
    },
  }),
}));

import {
  ProjectShareControl,
  type ProjectSettingsRow,
} from '../src/components/settings/project-settings';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makeRow(overrides: Partial<ProjectSettingsRow> = {}): ProjectSettingsRow {
  return {
    key: 'machine-1:proj-1',
    machineId: 'machine-1' as MachineId,
    machineName: 'MacBook Pro',
    shell: 'bash',
    project: {
      id: 'proj-1' as LocalProjectId,
      name: 'lody',
      rootPath: '/repo/lody',
    },
    sharedWithTeam: false,
    machineSharedWithTeam: true,
    conversationCount: 0,
    isUpdating: false,
    canUpdateSharing: true,
    worktreeSetup: { scripts: {} },
    isWorktreeSetupLoading: false,
    isWorktreeSetupSaving: false,
    worktreeSetupError: null,
    worktreeCleanup: { scripts: {} },
    isWorktreeCleanupLoading: false,
    isWorktreeCleanupSaving: false,
    worktreeCleanupError: null,
    historyImports: [],
    ...overrides,
  };
}

describe('ProjectShareControl', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mocks.teamSharing = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = (props: Parameters<typeof ProjectShareControl>[0]) =>
    act(async () => root.render(<ProjectShareControl {...props} />));

  it('hides completely when teamSharing capability is unavailable', async () => {
    mocks.teamSharing = false;
    await render({ row: makeRow() });
    expect(container.textContent).toBe('');
  });

  it('uses a static action label with a Private badge and machine-share consequence when machine is private', async () => {
    const onSharedWithTeamChange = vi.fn(async () => {});
    await render({
      row: makeRow({ sharedWithTeam: false, machineSharedWithTeam: false }),
      onSharedWithTeamChange,
    });

    expect(container.textContent).toContain('Share project with team');
    expect(container.textContent).toContain('Private');
    expect(container.textContent).toContain('Turning this on also shares MacBook Pro');
    expect(container.textContent).not.toContain('Private to you');

    const toggle = container.querySelector('[role="switch"]') as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      toggle.click();
    });
    expect(onSharedWithTeamChange).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'machine-1:proj-1' }),
      true
    );
  });

  it('omits the machine-sharing warning when the machine is already shared', async () => {
    await render({
      row: makeRow({ sharedWithTeam: false, machineSharedWithTeam: true }),
      onSharedWithTeamChange: async () => {},
    });

    expect(container.textContent).toContain('Share project with team');
    expect(container.textContent).toContain('Private');
    expect(container.textContent).toContain(
      'Turning this on lets teammates open and continue conversations in this project.'
    );
    expect(container.textContent).not.toContain('also shares');
  });

  it('shows Shared status and summary when both project and machine are shared', async () => {
    await render({
      row: makeRow({ sharedWithTeam: true, machineSharedWithTeam: true }),
      onSharedWithTeamChange: async () => {},
    });

    expect(container.textContent).toContain('Share project with team');
    expect(container.textContent).toContain('Shared');
    expect(container.textContent).toContain(
      'Teammates can open and continue conversations in this project.'
    );
    const toggle = container.querySelector('[role="switch"]') as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('warns and offers a shortcut when project sharing is on while its machine is private', async () => {
    const onOpenMachineSettings = vi.fn();
    await render({
      row: makeRow({ sharedWithTeam: true, machineSharedWithTeam: false }),
      onSharedWithTeamChange: async () => {},
      onOpenMachineSettings,
    });

    expect(container.textContent).toContain('Machine private');
    expect(container.textContent).toContain(
      'Project sharing is on, but MacBook Pro is private, so teammates cannot access this project yet.'
    );
    const button = Array.from(container.querySelectorAll('button')).find((el) =>
      el.textContent?.includes('Open MacBook Pro settings')
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
    expect(onOpenMachineSettings).toHaveBeenCalledWith('machine-1');
  });

  it('disables the switch and shows the preparing notice while the machine connects', async () => {
    const onSharedWithTeamChange = vi.fn(async () => {});
    await render({
      row: makeRow({ canUpdateSharing: false, sharedWithTeam: false }),
      onSharedWithTeamChange,
    });

    expect(container.textContent).toContain(
      'Sharing will be available when this machine finishes connecting.'
    );
    const toggle = container.querySelector('[role="switch"]') as HTMLElement;
    expect(
      toggle.hasAttribute('disabled') ||
        toggle.getAttribute('aria-disabled') === 'true' ||
        toggle.hasAttribute('data-disabled')
    ).toBe(true);
    await act(async () => {
      toggle.click();
    });
    expect(onSharedWithTeamChange).not.toHaveBeenCalled();
  });
});
