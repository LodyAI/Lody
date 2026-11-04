// @vitest-environment jsdom

// @vitest-environment jsdom
import { act } from 'react';
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
      inserted = handle?.insertPathMentions([{ path, kind: 'dir' }]) ?? false;
    });
    await render(value);
    return inserted;
  }

  it('moves existing mention ranges when an external quote atom is inserted before them', async () => {
    await render('');
    await insert('src');
    await act(async () => {
      expect(handle?.insertExternalMention({ text: '[Quote]', id: 'quote-1', at: 0 })).toBe(true);
    });
    await render(value);
    expect(value).toBe('[Quote]@src ');
    expect(ranges).toContainEqual({ value: 'src/', start: 7, end: 11, kind: 'dir' });
    expect(ranges).toContainEqual({ value: 'quote-1', start: 0, end: 7, kind: 'pasted_text' });
  });

  it.each(['/', 'C:/'])('preserves the absolute root %s', async (path) => {
    await render('look at');
    expect(await insert(path)).toBe(true);
    expect(value).toBe(`look at @${path} `);
    expect(ranges).toEqual([{ value: path, start: 8, end: 9 + path.length, kind: 'dir' }]);
  });

  it('keeps every folder and existing range from a single drop', async () => {
    await render('look at');
    await insert('/existing');
    await act(async () => {
      handle?.insertPathMentions([
        { path: '/first', kind: 'dir' },
        { path: '/second folder', kind: 'dir' },
      ]);
    });
    await render(value);
    expect(value).toBe('look at @/existing @/first @/second folder ');
    const input = container.querySelector('textarea')!;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(value.length);
    expect(input.selectionEnd).toBe(value.length);
    expect(
      ranges.map((range) => ({
        text: value.slice(range.start, range.end),
        value: range.value,
        kind: range.kind,
      }))
    ).toEqual([
      { text: '@/existing', value: '/existing/', kind: 'dir' },
      { text: '@/first', value: '/first/', kind: 'dir' },
      { text: '@/second folder', value: '/second folder/', kind: 'dir' },
    ]);
  });
});
