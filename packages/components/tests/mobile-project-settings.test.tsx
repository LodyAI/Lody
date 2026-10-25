// @vitest-environment jsdom

import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';
import { MobileProjectSettings } from '../src/components/mobile/mobile-project-settings';
import { initI18n } from '../src/i18n';

const studio = 'machine-studio' as MachineId;

describe('mobile project settings', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it('lists multi-repository projects like the sidebar and offers creating one', () => {
    const onCreateMultiRepoProject = vi.fn();
    const onOpenMultiRepoProject = vi.fn();
    flushSync(() => {
      root?.render(
        <MobileProjectSettings
          sections={[]}
          githubSections={[]}
          isLoading={false}
          githubProjectsLoading={false}
          addableMachines={[
            { machineId: studio, machineName: 'Studio', online: true, sharedWithTeam: false },
          ]}
          onAddLocalProject={() => undefined}
          multiRepoProjects={[
            { id: 'shop', name: 'Shop', memberCount: 3, boundMachineId: studio, canManage: true },
            { id: 'docs', name: 'Docs', memberCount: 2, boundMachineId: null, canManage: true },
          ]}
          onCreateMultiRepoProject={onCreateMultiRepoProject}
          onOpenMultiRepoProject={onOpenMultiRepoProject}
        />
      );
    });
    const sections = Array.from(container?.querySelectorAll('section') ?? []);
    const sectionOf = (text: string) =>
      sections.find((section) => section.textContent?.includes(text));
    // Shop needs Studio, so it sits with Studio's folders; Docs runs anywhere.
    expect(sectionOf('Shop')).toBe(sectionOf('Add folder'));
    expect(sectionOf('Docs')?.textContent).toContain('Any machine');
    expect(sectionOf('Docs')).not.toBe(sectionOf('Shop'));

    const button = (text: string) =>
      Array.from(container?.querySelectorAll<HTMLElement>('button') ?? []).find((node) =>
        node.textContent?.includes(text)
      );
    flushSync(() => button('Shop')?.click());
    expect(onOpenMultiRepoProject).toHaveBeenCalledWith('shop');
    flushSync(() => button('Several repositories or folders')?.click());
    expect(onCreateMultiRepoProject).toHaveBeenCalledTimes(1);
  });
});
