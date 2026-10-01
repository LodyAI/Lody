// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { SessionPullRequestMeta } from '@lody/shared';

import { autoArchiveOnPrClosedAtom, autoArchiveOnPrMergedAtom } from '../src/atoms/settings';
import { AutoArchiveSection } from '../src/components/settings/auto-archive-setting';
import { initI18n } from '../src/i18n';

import {
  getAutoArchivePrDecision,
  getAutoArchivePrSnapshot,
  pickLatestPr,
  type AutoArchivePrSnapshot,
} from '../src/lib/auto-archive-pr';

const createPullRequest = (
  overrides: Partial<SessionPullRequestMeta> = {}
): SessionPullRequestMeta => ({
  url: 'https://github.com/loro-dev/lody/pull/2000',
  number: 2000,
  repository: 'loro-dev/lody',
  branch: 'fix/pr-auto-archive',
  status: 'open',
  reportedAt: '2026-05-05T10:00:00.000Z',
  ...overrides,
});

const snapshot = (overrides: Partial<AutoArchivePrSnapshot> = {}): AutoArchivePrSnapshot => ({
  url: 'https://github.com/loro-dev/lody/pull/2000',
  status: 'open',
  ...overrides,
});

describe('pickLatestPr', () => {
  it('picks the newest PR by reportedAt even when input is not sorted', () => {
    expect(
      pickLatestPr([
        createPullRequest({
          number: 1,
          url: 'https://github.com/loro-dev/lody/pull/1',
          reportedAt: '2026-05-05T10:00:00.000Z',
        }),
        createPullRequest({
          number: 2,
          url: 'https://github.com/loro-dev/lody/pull/2',
          reportedAt: '2026-05-05T11:00:00.000Z',
        }),
      ])?.number
    ).toBe(2);
  });
});

describe('getAutoArchivePrSnapshot', () => {
  it('returns the latest PR identity and status', () => {
    expect(
      getAutoArchivePrSnapshot([
        createPullRequest({
          status: 'merged',
          reportedAt: '2026-05-05T11:00:00.000Z',
        }),
      ])
    ).toEqual({
      url: 'https://github.com/loro-dev/lody/pull/2000',
      status: 'merged',
    });
  });
});

describe('getAutoArchivePrDecision', () => {
  it('archives when an observed PR transitions from open to merged', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'open' }),
        current: snapshot({ status: 'merged' }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: true, status: 'merged' });
  });

  it('does not archive a restored session whose PR is still merged', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'merged' }),
        current: snapshot({ status: 'merged' }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: false, status: 'merged' });
  });

  it('does not retro-archive when the first observed PR state is terminal', () => {
    expect(
      getAutoArchivePrDecision({
        previous: undefined,
        current: snapshot({ status: 'closed' }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: false, status: 'closed' });
  });

  it('archives if a restored PR later changes to a new enabled terminal state', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'open' }),
        current: snapshot({ status: 'closed' }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: true, status: 'closed' });
  });

  it('does not archive a different PR that is first observed as terminal', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({
          url: 'https://github.com/loro-dev/lody/pull/1999',
          status: 'open',
        }),
        current: snapshot({
          url: 'https://github.com/loro-dev/lody/pull/2000',
          status: 'merged',
        }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: false, status: 'merged' });
  });

  it('respects the merged and closed settings independently', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'open' }),
        current: snapshot({ status: 'merged' }),
        archiveOnMerged: false,
        archiveOnClosed: true,
      }).shouldArchive
    ).toBe(false);

    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'open' }),
        current: snapshot({ status: 'closed' }),
        archiveOnMerged: true,
        archiveOnClosed: false,
      }).shouldArchive
    ).toBe(false);
  });
});

describe('AutoArchiveSection', () => {
  it.each([
    {
      language: 'en',
      notice: [
        'chats and local branches',
        'ignored by Git',
        'cleanup scripts',
        'outside the worktree',
        'only here, for your sessions',
      ],
    },
    {
      language: 'zh_CN',
      notice: [
        '对话和分支还在',
        '所属机器',
        '被 Git 忽略',
        '清理脚本改动、删除',
        '工作树之外',
        '仅在本机',
      ],
    },
  ])(
    'shows retention limits in $language while keeping the rules independent',
    async ({ language, notice }) => {
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
      await initI18n(language);
      const store = createStore();
      store.set(autoArchiveOnPrMergedAtom, false);
      store.set(autoArchiveOnPrClosedAtom, false);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(createElement(Provider, { store }, createElement(AutoArchiveSection)));
        });
        for (const boundary of notice) expect(container.textContent).toContain(boundary);
        const switches = container.querySelectorAll<HTMLElement>('[role="switch"]');
        expect(switches).toHaveLength(2);
        await act(async () => switches[0]?.click());
        expect(store.get(autoArchiveOnPrMergedAtom)).toBe(true);
        expect(store.get(autoArchiveOnPrClosedAtom)).toBe(false);
        expect(switches[0]?.getAttribute('aria-checked')).toBe('true');
        await act(async () => switches[1]?.click());
        expect(store.get(autoArchiveOnPrMergedAtom)).toBe(true);
        expect(store.get(autoArchiveOnPrClosedAtom)).toBe(true);
        expect(switches[1]?.getAttribute('aria-checked')).toBe('true');
      } finally {
        await act(async () => root.unmount());
        container.remove();
        localStorage.removeItem('lody-auto-archive-on-pr-merged');
        localStorage.removeItem('lody-auto-archive-on-pr-closed');
        await initI18n('en');
      }
    }
  );
});
