// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubSettingsView } from '../src/components/settings/github-settings-view';
import type { SettingsWorkspaceRepoWithStatus } from '../src/components/settings/settings-data-cache';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const repo = (repoFullName: string, enabled: boolean): SettingsWorkspaceRepoWithStatus => ({
  repoFullName,
  name: repoFullName.split('/')[1]!,
  repositoryId: repoFullName.length,
  private: false,
  enabled,
});

const repos = [
  repo('loro-dev/loro', true),
  repo('LodyAI/lody-cloud', false),
  repo('loro-dev/lody', false),
  repo('LodyAI/acp-extension-core', true),
  repo('zxch3n/blog', false),
  repo('zxch3n/dotfiles', true),
];

describe('GitHubSettingsView', () => {
  let root: Root;
  let container: HTMLDivElement;
  const toggled: Array<[string, boolean]> = [];

  const render = async (canManage: boolean) => {
    await act(async () => {
      root.render(
        createElement(GitHubSettingsView, {
          canManage,
          workspaceReady: true,
          connecting: false,
          onConnect: () => undefined,
          identity: {
            enabled: false,
            authorizationState: 'missing',
            onToggle: () => undefined,
            onAuthorize: () => undefined,
          },
          repos,
          reposLoading: false,
          onToggleRepo: (name, enabled) => toggled.push([name, enabled]),
        })
      );
    });
  };

  const ownerHeadings = () =>
    [...container.querySelectorAll('section header p')].map((node) => node.textContent);
  const repoSwitch = (name: string) =>
    container.querySelector<HTMLElement>(`[role="switch"][aria-label="${name}"]`);

  beforeEach(async () => {
    await initI18n('en');
    toggled.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('groups repositories under their owner, in arrival order, and summarises what is enabled', async () => {
    await render(true);
    expect(ownerHeadings()).toEqual(['loro-dev', 'LodyAI', 'zxch3n']);
    expect(container.textContent).toContain('3 of 6 repositories enabled');

    await act(async () => repoSwitch('loro-dev/lody')!.click());
    expect(toggled).toEqual([['loro-dev/lody', true]]);
  });

  it('narrows the owners to the repositories matching the search', async () => {
    await render(true);
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(search, 'dot');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ownerHeadings()).toEqual(['zxch3n']);
    expect(repoSwitch('zxch3n/dotfiles')).not.toBeNull();
    expect(repoSwitch('zxch3n/blog')).toBeNull();
  });

  it('shows a member the repositories without letting them change any', async () => {
    await render(false);
    expect(container.textContent).toContain(
      'Only workspace admins can manage GitHub integrations.'
    );
    await act(async () => repoSwitch('loro-dev/loro')!.click());
    expect(toggled).toEqual([]);
  });
});
