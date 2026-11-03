// @vitest-environment jsdom

import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';
import { MobileProjectScreen } from '../src/components/mobile/mobile-project-screen';
import { MobileSettingsFoldPanels } from '../src/components/mobile/mobile-settings-fold-panels';
import { MobileProjectSettings } from '../src/components/mobile/mobile-project-settings';
import { initI18n } from '../src/i18n';

const studio = 'machine-studio' as MachineId;

describe('mobile project settings', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    delete window.__LODY_HORIZONTAL_DIVISION__;
    document.documentElement.style.removeProperty('--native-keyboard-height');
    vi.restoreAllMocks();
  });

  it('splits project settings on the fold and keeps their content mounted when the keyboard opens', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 900,
      left: 0,
      right: 669,
      width: 669,
      height: 800,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 455, height: 40, viewportHeight: 951 };
    await act(async () =>
      root?.render(
        <MobileProjectScreen
          project={{ kind: 'github', fullName: 'org/repo', name: 'repo', ownerHandle: 'org' }}
          conversations={[]}
          filesTabContent={<div>Files</div>}
          onBack={() => {}}
          labels={{ settingsTab: 'Settings' }}
          settingsTabContent={
            <MobileSettingsFoldPanels
              upper={<input aria-label="Project draft" defaultValue="unsaved" />}
              lower={<div>Project skills</div>}
            />
          }
        />
      )
    );
    const settings = [...container!.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Settings')
    )!;
    await act(async () => settings.click());
    const upper = container!.querySelector<HTMLElement>('[data-settings-fold-upper]')!;
    const lower = container!.querySelector<HTMLElement>('[data-settings-fold-lower]')!;
    const draft = upper.querySelector<HTMLInputElement>('input')!;
    expect(upper.style.flexBasis).toBe('355px');
    expect(lower.textContent).toContain('Project skills');
    expect(lower.classList.contains('overflow-y-auto')).toBe(true);
    await act(async () => {
      document.documentElement.style.setProperty('--native-keyboard-height', '300px');
      window.dispatchEvent(new Event('lody:keyboard-resize'));
    });
    expect(lower.classList.contains('overflow-y-auto')).toBe(false);
    expect(upper.querySelector('input')).toBe(draft);
    expect(draft.value).toBe('unsaved');
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
