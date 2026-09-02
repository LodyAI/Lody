// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/mentions/mention-project-file-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectFiles: () => ({
    fileData: { entry: null, status: 'ready' as const },
    initializeLazyDirectory: async () => undefined,
    getKnownFileTokens: () => new Set<string>(),
  }),
}));

vi.mock('../src/components/mentions/mention-skill-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectSkills: () => ({
    skillState: { status: 'ready' as const },
    skillItems: [],
    knownSkillTokens: new Set<string>(),
  }),
}));

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));

vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import {
  CombinedMentionTextarea,
  type CombinedMentionTextareaHandle,
} from '../src/components/mentions/combined-mention-textarea';
import type { Mention as MentionRange } from '../src/ui/mention/index';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A path mention written from OUTSIDE the composer — a folder dropped from the
 * OS. Asserted at the composer boundary for the same reason the session drop
 * is: the drop must produce the artefact a menu commit does, text plus a
 * committed range, or the chip never renders and the token is just a word.
 */
describe('inserting a path mention from outside the composer', () => {
  let root: Root;
  let container: HTMLDivElement;
  let handle: CombinedMentionTextareaHandle | null;
  let value: string;
  let ranges: MentionRange[];

  beforeEach(async () => {
    await initI18n('en');
    handle = null;
    value = '';
    ranges = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(next = value) {
    value = next;
    await act(async () => {
      root.render(
        <CombinedMentionTextarea
          value={value}
          onValueChange={(text) => {
            value = text;
          }}
          mentionSource={{ kind: 'local', localProjectId: 'p1' } as never}
          mentionActionsRef={(instance) => {
            handle = instance;
          }}
          onMentionRangesChange={(nextRanges) => {
            ranges = nextRanges;
          }}
          resetOnEmpty={false}
        />
      );
    });
  }

  async function insert(path: string) {
    let inserted = false;
    await act(async () => {
      inserted = handle?.insertPathMention({ path, kind: 'dir' }) ?? false;
    });
    await render(value);
    return inserted;
  }

  it('writes @dir and a range carrying the directory token', async () => {
    await render('');

    expect(await insert('src/components')).toBe(true);
    expect(value).toBe('@src/components ');
    // Same payload shape as a directory committed from the `@` menu.
    expect(ranges).toEqual([{ value: 'src/components/', start: 0, end: 15, kind: 'dir' }]);
  });

  it('appends to an existing draft with one separating space', async () => {
    await render('look at');

    expect(await insert('/Users/dev/other/')).toBe(true);
    expect(value).toBe('look at @/Users/dev/other ');
    expect(ranges.map((range) => value.slice(range.start, range.end))).toEqual([
      '@/Users/dev/other',
    ]);
  });

  it('writes nothing for an empty path', async () => {
    await render('hello');
    expect(await insert('/')).toBe(false);
    expect(value).toBe('hello');
    expect(ranges).toHaveLength(0);
  });
});
