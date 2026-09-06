// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let knownFileTokens = new Set<string>();
let knownSkillTokens = new Set<string>();
let sessionItems: Array<{ sessionId: string; title: string; slug: string }> = [];
let issueItems = new Map<number, { type: 'issue' | 'pr'; title: string; url?: string }>();

vi.mock('../src/components/mentions/mention-project-file-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectFiles: () => ({
    fileData: { entry: null, status: 'ready' as const },
    initializeLazyDirectory: async () => undefined,
    getKnownFileTokens: () => knownFileTokens,
  }),
}));

vi.mock('../src/components/mentions/mention-skill-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectSkills: () => ({
    skillState: { status: 'ready' as const },
    skillItems: [],
    knownSkillTokens,
  }),
}));

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => sessionItems,
}));

// Agent Roles read the visible-machine index, which needs the authenticated
// Convex context; the same reason the session source above is stubbed.
vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

vi.mock('../src/components/mentions/issue-pr-hash-mention', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useKnownIssuePrItems: () => ({
    knownItems: issueItems,
    issuePrData: { entry: null, status: 'ready' as const, refresh: async () => undefined },
  }),
}));

import { CombinedMentionTextarea } from '../src/components/mentions/combined-mention-textarea';
import { getComposerMentionChip } from '../src/components/mentions/mention-chips';
import {
  toPersistedMentionRanges,
  type PersistedMentionRange,
} from '../src/components/mentions/mention-persistence';
import { initI18n } from '../src/i18n';
import { encodeBrowserPageReference } from '@lody/shared';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * One kind of mention must not cost another its decoration.
 *
 * Every hydrator runs its effect in the same flush, so before
 * `useFlushConsistentState` each one resolved its update against the pre-flush
 * value and the last to render REPLACED the rest. The reported symptom was a
 * session mention going plain whenever a skill or issue mention shared the
 * draft — those two render after it — and it only showed up after a remount,
 * because while the composer stays mounted the ranges are the ones the menu
 * committed one at a time.
 *
 * Each case asserts the same set twice: as first hydrated, and again after the
 * round trip through the persisted ranges.
 */
describe('a draft with several kinds of mention keeps all of them', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    knownFileTokens = new Set(['src/app.ts']);
    knownSkillTokens = new Set(['review']);
    sessionItems = [
      { sessionId: 'sess_fix', title: 'Fix CI', slug: 'fix-ci', activityAt: 1 } as never,
    ];
    issueItems = new Map([[123, { type: 'issue' as const, title: 'Bug' }]]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const kinds = () =>
    Array.from(
      new Set(
        Array.from(container.querySelectorAll('[data-mention-kind]')).map((n) =>
          n.getAttribute('data-mention-kind')
        )
      )
    ).sort();

  async function render(props: {
    value: string;
    persisted?: readonly PersistedMentionRange[];
    onRanges?: (ranges: never) => void;
  }) {
    await act(async () => {
      root.render(
        <CombinedMentionTextarea
          value={props.value}
          onValueChange={() => undefined}
          mentionSource={
            { kind: 'local', localProjectId: 'p1', githubRepoFullName: 'o/r' } as never
          }
          skillAgent={{ machineId: 'm1' } as never}
          persistedMentions={props.persisted}
          onMentionRangesChange={props.onRanges as never}
          getMentionChip={getComposerMentionChip}
          resetOnEmpty={false}
        />
      );
    });
  }

  const roundTrip = async (text: string, expected: string[]) => {
    let reported: PersistedMentionRange[] = [];
    await render({
      value: text,
      onRanges: ((r: never) => {
        reported = toPersistedMentionRanges(r);
      }) as never,
    });
    expect(kinds()).toEqual(expected);

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await render({ value: text, persisted: reported });
    expect(kinds()).toEqual(expected);
  };

  it('keeps a session mention beside a file mention', async () => {
    await roundTrip('see @fix-ci and @src/app.ts', ['file', 'session']);
  });
  it('restores URL and browser references beside files without loading their sources', async () => {
    const url = 'https://example.test/docs';
    const text = `@src/app.ts ${url} ${url}`;
    const target = encodeBrowserPageReference({
      version: 1,
      machineId: 'm',
      sessionId: 's',
      url,
      title: 'Frozen title',
    });
    if (!target) throw new Error('Invalid fixture');
    const persisted: PersistedMentionRange[] = [
      { start: 0, end: 11, kind: 'file', value: 'src/app.ts' },
      { start: 12, end: 12 + url.length, kind: 'url', value: url },
      { start: 13 + url.length, end: text.length, kind: 'browser_page', value: target },
    ];
    await render({ value: text, persisted });
    expect(kinds()).toEqual(['browser_page', 'file', 'url']);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ value: text, persisted });
    expect(kinds()).toEqual(['browser_page', 'file', 'url']);
  });

  it('keeps a session mention beside a skill mention', async () => {
    await roundTrip('see @fix-ci and $review', ['session', 'skill']);
  });

  it('keeps a session mention beside an issue mention', async () => {
    await roundTrip('see @fix-ci and #123', ['issue', 'session']);
  });

  it('keeps all four kinds at once', async () => {
    await roundTrip('see @fix-ci @src/app.ts $review #123', ['file', 'issue', 'session', 'skill']);
  });

  it('keeps all four when the session mention comes last in the text', async () => {
    await roundTrip('see @src/app.ts $review #123 @fix-ci', ['file', 'issue', 'session', 'skill']);
  });
});
