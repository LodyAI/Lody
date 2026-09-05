// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectShortcutIndex,
  type PromptShortcut,
  type PromptShortcutRuntime,
} from '@lody/shared/prompt-shortcuts';
import type { usePromptShortcuts } from '../src/providers/prompt-shortcut-provider';
import { PromptShortcutsSetting } from '../src/components/settings/prompt-shortcuts-setting';
import { initI18n } from '../src/i18n';

vi.mock('../src/providers/prompt-shortcut-provider', () => ({ usePromptShortcuts: () => state }));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: () => [],
  usePlatformCapability: () => false,
}));
vi.mock('jotai', async (original) => ({ ...(await original<object>()), useAtomValue: () => [] }));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ machines: new Map() }),
}));
vi.mock('../src/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjectsFromMachineIndex: () => ({ projects: new Map() }),
}));
vi.mock('../src/hooks/use-machine-flock-agent-configs', () => ({
  useMachineFlockAgentConfigsForMachineIds: () => {},
}));
vi.mock('../src/components/mentions/combined-mention-textarea', () => ({
  CombinedMentionTextarea: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const shortcut: PromptShortcut = {
  v: 1,
  id: 'shortcut',
  workspaceId: 'ws',
  ownerUserId: 'alice',
  revision: 'r1',
  visibility: 'private',
  name: 'Private review',
  slug: 'review',
  prompt: 'Private content',
  scope: {},
  mentions: [],
  variables: [],
  createdAt: 1,
  updatedAt: 1,
};
let state: ReturnType<typeof usePromptShortcuts>;
let root: Root, container: HTMLDivElement;
function runtime(workspaceId: string, userId: string, read = async () => shortcut) {
  return { workspaceId, userId, canShare: true, read } as unknown as PromptShortcutRuntime;
}
beforeEach(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  await initI18n('en');
  state = {
    runtime: runtime('ws', 'alice'),
    entries: [projectShortcutIndex(shortcut, 'body')],
    pendingIds: [],
    errors: {},
    loading: false,
    retry: () => {},
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<PromptShortcutsSetting />));
}
async function open() {
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Private review'))!
      .click();
  });
}
describe('Prompt Shortcut settings identity fencing', () => {
  it.each([
    ['other-ws', 'alice'],
    ['ws', 'bob'],
  ])('drops the private editor when switching to %s / %s', async (workspaceId, userId) => {
    await render();
    await open();
    expect(document.querySelector<HTMLInputElement>('#shortcut-name')?.value).toBe(
      'Private review'
    );
    state = { ...state, runtime: runtime(workspaceId, userId), entries: [] };
    await render();
    expect(document.querySelector('#shortcut-name')).toBeNull();
    expect(document.body.textContent).not.toContain('Private review');
  });
  it('ignores a body read that completes after a workspace switch', async () => {
    let complete!: (value: PromptShortcut) => void;
    const body = new Promise<PromptShortcut>((resolve) => {
      complete = resolve;
    });
    state = { ...state, runtime: runtime('ws', 'alice', () => body) };
    await render();
    await open();
    state = { ...state, runtime: runtime('other', 'alice'), entries: [] };
    await render();
    await act(async () => {
      complete(shortcut);
      await body;
    });
    expect(document.querySelector('#shortcut-name')).toBeNull();
    expect(document.body.textContent).not.toContain('Private review');
  });
});
