// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectMemberId } from '@lody/shared';
import { SessionProjectMembersChip } from '../src/components/sessions/session-project-members-chip';
import { initI18n } from '../src/i18n';

const rows = [
  {
    id: 'api' as ProjectMemberId,
    path: 'api',
    kind: 'github' as const,
    isSubmodule: false,
    depth: 0,
    hasChildren: true,
    repoFullName: 'acme/api',
    branch: 'lody/export',
    dirty: false,
    unpushed: false,
  },
  {
    id: 'proto' as ProjectMemberId,
    path: 'api/proto',
    kind: 'github' as const,
    isSubmodule: true,
    parentId: 'api' as ProjectMemberId,
    depth: 1,
    hasChildren: false,
    repoFullName: 'acme/proto',
    branch: 'lody/export-proto',
    dirty: false,
    unpushed: false,
    pr: {
      url: 'https://github.com/acme/proto/pull/5',
      number: 5,
      status: 'open' as const,
      ciState: 'f' as const,
    },
  },
];

describe('SessionProjectMembersChip', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  it('indents a submodule under its parent and selects it as the active repository', async () => {
    const onSelectMember = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <SessionProjectMembersChip
          groupName="Shop"
          rows={rows}
          selectedMemberId={'api' as ProjectMemberId}
          onSelectMember={onSelectMember}
          onOpenPullRequest={() => undefined}
          defaultOpen
        />
      );
    });

    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="listitem"]'));
    expect(items).toHaveLength(2);
    expect(items[0]!.style.paddingInlineStart).toBe('4px');
    expect(items[1]!.style.paddingInlineStart).toBe('18px');
    expect(items[0]!.textContent).toContain('acme/api');
    expect(items[0]!.textContent).toContain('api');
    expect(items[0]!.textContent).toContain('lody/export');
    expect(items[1]!.textContent).toContain('acme/proto');
    expect(items[1]!.textContent).toContain('api/proto');
    // A repository without a PR keeps the slot empty instead of saying "No PR".
    expect(items[0]!.textContent).not.toContain('No PR');
    // Unpublished work is not a separate dot either.
    expect(document.querySelector('[role="img"]')).toBeNull();

    const protoButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.getAttribute('aria-label')?.startsWith('acme/proto')
    );
    expect(protoButton).toBeDefined();
    expect(protoButton!.getAttribute('aria-current')).toBeNull();
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.getAttribute('aria-label')?.startsWith('acme/api'))
        ?.getAttribute('aria-current')
    ).toBe('true');
    await act(async () => {
      protoButton!.click();
    });

    expect(onSelectMember).toHaveBeenCalledWith('proto');
    // The panel closes so the stage it just changed becomes visible.
    expect(document.querySelector('[role="listitem"]')).toBeNull();
  });

  it('opening a row’s pull request also selects that repository', async () => {
    const onSelectMember = vi.fn();
    const onOpenPullRequest = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <SessionProjectMembersChip
          groupName="Shop"
          rows={rows}
          selectedMemberId={'api' as ProjectMemberId}
          onSelectMember={onSelectMember}
          onOpenPullRequest={onOpenPullRequest}
          defaultOpen
        />
      );
    });

    const prButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.getAttribute('aria-label')?.startsWith('Open pull request #5')
    );
    expect(prButton).toBeDefined();
    expect(prButton!.getAttribute('aria-label')).toBe('Open pull request #5 · CI failed');
    // CI tints the PR glyph; there is no separate status dot beside it.
    expect(prButton!.querySelector('svg')?.getAttribute('class')).toContain('text-destructive');
    expect(prButton!.querySelectorAll('span[aria-hidden="true"]').length).toBe(0);
    await act(async () => {
      prButton!.click();
    });

    expect(onSelectMember).toHaveBeenCalledWith('proto');
    expect(onOpenPullRequest).toHaveBeenCalledWith('https://github.com/acme/proto/pull/5');
  });
});
