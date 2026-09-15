// @vitest-environment jsdom

import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectMeta, MachineId } from '@lody/shared';

import { LocalProjectItem } from '../src/components/loro-app-sidebar';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';

// A project hosted on a machine a teammate shared with the workspace. The row
// must behave exactly like one on this user's own device: clicking it steers the
// chat landing to that machine + project, and the new-chat button is offered.
const machineId = 'machine-teammate' as MachineId;
const project = {
  id: 'project-shared',
  name: 'Lody',
  rootPath: '/workspace/lody',
} as LocalProjectMeta;

describe('sidebar local project row', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function render(options: {
    onNavigateProject: (machineId: MachineId, localProjectId: string) => void;
    onNewChatInProject: (machineId: MachineId, localProjectId: string) => void;
    removalState?: 'waiting_for_device' | 'removing' | null;
  }) {
    flushSync(() => {
      root?.render(
        <TooltipProvider>
          <LocalProjectItem
            machineId={machineId}
            machineName="Teammate's Mac"
            project={project}
            // Removal stays owner-only; navigation does not depend on it.
            canRemoveProject={false}
            removalState={options.removalState ?? null}
            collapsed={false}
            isSelected={false}
            sessionsForProject={[]}
            childSessionsByParent={new Map()}
            liveSessionStatuses={new Map()}
            formattedPath={project.rootPath}
            defaultSessionTitle="New session"
            selectedSessionId={null}
            removeProjectLabel="Remove folder"
            newChatLabel="New chat"
            archiveTooltipLabel="Archive session"
            archiveActionLabel="Archive"
            archiveConfirmLabel="Confirm"
            isMobile={false}
            toggleLabel="Toggle"
            onNavigateProject={options.onNavigateProject}
            onNewChatInProject={options.onNewChatInProject}
            onNavigateSession={() => undefined}
            onArchive={() => undefined}
            collapsedOpenedBySessionIds={{}}
            onToggleOpenedBySessions={() => undefined}
            onToggleCollapsed={() => undefined}
            onRequestRemoval={() => undefined}
          />
        </TooltipProvider>
      );
    });
    return container?.querySelector<HTMLElement>(`[data-id="project:${machineId}:${project.id}"]`);
  }

  it('activates the project on the landing and offers a new chat for a shared machine', () => {
    const onNavigateProject = vi.fn();
    const onNewChatInProject = vi.fn();
    const row = render({ onNavigateProject, onNewChatInProject });

    expect(row?.getAttribute('role')).toBe('button');
    expect(row?.getAttribute('aria-disabled')).toBeNull();

    flushSync(() => row?.click());
    expect(onNavigateProject).toHaveBeenCalledWith(machineId, project.id);

    const newChatButton = row?.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);
    flushSync(() => newChatButton?.click());
    expect(onNewChatInProject).toHaveBeenCalledWith(machineId, project.id);
    // Starting a fresh chat must not double as a plain row activation.
    expect(onNavigateProject).toHaveBeenCalledTimes(1);
  });

  it('goes inert while the project is being removed', () => {
    const onNavigateProject = vi.fn();
    const onNewChatInProject = vi.fn();
    const row = render({ onNavigateProject, onNewChatInProject, removalState: 'removing' });

    expect(row?.getAttribute('role')).toBeNull();
    expect(row?.getAttribute('aria-disabled')).toBe('true');

    flushSync(() => row?.click());
    expect(onNavigateProject).not.toHaveBeenCalled();
    expect(row?.querySelector('button[aria-label="New chat"]')).toBeNull();
  });
});
