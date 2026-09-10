// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let knownFileTokens = new Set<string>();
let knownSkillTokens = new Set<string>();
let sessionItems: Array<{ sessionId: string; title: string; slug: string }> = [];

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

import { CombinedMentionTextarea } from '../src/components/mentions/combined-mention-textarea';
import { getComposerMentionChip } from '../src/components/mentions/mention-chips';
import {
  toPersistedMentionRanges,
  type PersistedMentionRange,
} from '../src/components/mentions/mention-persistence';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A stand-in for `session-chat-input-area.tsx`: module-level draft + range
 * caches keyed by session, seeded into state, and a render-phase switch branch.
 */
const draftCache = new Map<string, string>();
const rangeCache = new Map<string, PersistedMentionRange[]>();
const getRanges = (id: string) => [...(rangeCache.get(id) ?? [])];
const setRanges = (id: string, ranges: readonly PersistedMentionRange[]) => {
  if (ranges.length === 0) rangeCache.delete(id);
  else rangeCache.set(id, [...ranges]);
};

function FakeSessionComposer({ sessionId }: { sessionId: string }) {
  const [userInput, setUserInput] = React.useState(() => draftCache.get(sessionId) ?? '');
  const [persisted, setPersisted] = React.useState(() => getRanges(sessionId));

  const [prevSessionId, setPrevSessionId] = React.useState(sessionId);
  if (prevSessionId !== sessionId) {
    setPrevSessionId(sessionId);
    setUserInput(draftCache.get(sessionId) ?? '');
    setPersisted(getRanges(sessionId));
  }

  const handleRanges = React.useCallback(
    (ranges: Parameters<typeof toPersistedMentionRanges>[0]) => {
      setRanges(sessionId, toPersistedMentionRanges(ranges));
    },
    [sessionId]
  );

  return (
    <CombinedMentionTextarea
      value={userInput}
      onValueChange={(next) => {
        draftCache.set(sessionId, next);
        setUserInput(next);
      }}
      mentionSource={{ kind: 'local', localProjectId: 'p1' } as never}
      persistedMentions={persisted}
      draftKey={sessionId}
      onMentionRangesChange={handleRanges}
      getMentionChip={getComposerMentionChip}
    />
  );
}

/**
 * Leaving a composer and coming back must not cost a draft its mention
 * decoration. Both failures these cover were invisible until a remount: the
 * ranges a menu commits are correct while the composer stays mounted, and only
 * hydration — which runs on the way back — could lose them.
 */
describe('mention ranges survive leaving and returning to a draft', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    knownFileTokens = new Set<string>();
    knownSkillTokens = new Set<string>();
    sessionItems = [];
    draftCache.clear();
    rangeCache.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const kinds = () =>
    Array.from(container.querySelectorAll('[data-mention-kind]')).map((node) =>
      node.getAttribute('data-mention-kind')
    );

  async function render(props: {
    value: string;
    persisted?: readonly PersistedMentionRange[];
    draftKey?: string;
    resetOnEmpty?: boolean;
    onRanges?: (
      ranges: Array<{ start: number; end: number; value: string; kind?: string }>
    ) => void;
  }) {
    await act(async () => {
      root.render(
        <CombinedMentionTextarea
          value={props.value}
          onValueChange={() => undefined}
          mentionSource={{ kind: 'local', localProjectId: 'p1' } as never}
          persistedMentions={props.persisted}
          draftKey={props.draftKey}
          onMentionRangesChange={props.onRanges as never}
          getMentionChip={getComposerMentionChip}
          resetOnEmpty={props.resetOnEmpty ?? false}
        />
      );
    });
  }

  it('closes an open mention menu on external clear and keeps it closed for the next draft', async () => {
    knownFileTokens = new Set(['src/app.ts']);
    let setText!: React.Dispatch<React.SetStateAction<string>>;
    function Composer() {
      const [value, setValue] = React.useState('');
      setText = setValue;
      return (
        <CombinedMentionTextarea
          value={value}
          onValueChange={setValue}
          mentionSource={{ kind: 'local', localProjectId: 'p1' } as never}
        />
      );
    }
    await act(async () => root.render(<Composer />));
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        '@'
      );
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    await act(async () => setText(''));
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.getAttribute('aria-expanded')).toBe('false');
    await act(async () => setText('next draft'));
    expect(textarea.getAttribute('aria-expanded')).toBe('false');
  });

  it('clears and rehydrates mention data without replacing or blurring the input', async () => {
    knownFileTokens = new Set(['src/app.ts']);
    const props = { resetOnEmpty: true };
    await render({ ...props, value: 'look at @src/app.ts' });
    const textarea = container.querySelector('textarea')!;
    textarea.focus();
    expect(kinds()).toContain('file');
    await render({ ...props, value: '' });
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(kinds()).toEqual([]);
    await render({ ...props, value: 'look at @src/app.ts' });
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(kinds()).toContain('file');
  });

  it('restores the range from the persisted draft when the file index is cold', async () => {
    const text = 'look at @src/app.ts thanks';
    knownFileTokens = new Set(['src/app.ts']);

    let reported: PersistedMentionRange[] = [];
    await render({
      value: text,
      onRanges: (ranges) => {
        reported = toPersistedMentionRanges(ranges as never);
      },
    });
    expect(kinds()).toContain('file');
    expect(reported).toHaveLength(1);

    // Leave the view and come back: the composer remounts, the file index has
    // not been rebuilt yet, and only the persisted ranges are available.
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    knownFileTokens = new Set<string>();

    await render({ value: text, persisted: reported });
    expect(kinds()).toContain('file');
  });

  // Hydrators all fire in one effect flush. Resolving each update against the
  // last *rendered* value made them overwrite rather than merge, so a mixed
  // draft came back holding only whichever hydrator rendered last.
  it('restores BOTH a file and a session mention on return', async () => {
    const text = 'compare @src/app.ts with @fix-ci please';
    knownFileTokens = new Set(['src/app.ts']);
    sessionItems = [
      { sessionId: 'sess_1', title: 'Fix CI', slug: 'fix-ci', activityAt: 1 } as never,
    ];

    let reported: PersistedMentionRange[] = [];
    await render({
      value: text,
      onRanges: (ranges) => {
        reported = toPersistedMentionRanges(ranges as never);
      },
    });
    expect(Array.from(new Set(kinds())).sort()).toEqual(['file', 'session']);
    expect(reported).toHaveLength(2);

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await render({ value: text, persisted: reported });
    expect(Array.from(new Set(kinds())).sort()).toEqual(['file', 'session']);
  });

  it('restores a session-only draft on return (cold session list)', async () => {
    const text = 'see @fix-ci';
    sessionItems = [
      { sessionId: 'sess_1', title: 'Fix CI', slug: 'fix-ci', activityAt: 1 } as never,
    ];

    let reported: PersistedMentionRange[] = [];
    await render({
      value: text,
      onRanges: (ranges) => {
        reported = toPersistedMentionRanges(ranges as never);
      },
    });
    expect(kinds()).toContain('session');

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sessionItems = [];

    await render({ value: text, persisted: reported });
    expect(kinds()).toContain('session');
  });

  // The session composer swaps drafts without remounting, so a swap has to be
  // told apart from an edit; otherwise the outgoing ranges stay committed and
  // the incoming draft never hydrates.
  it('re-hydrates when the draft is swapped in place (session switch)', async () => {
    knownFileTokens = new Set(['src/app.ts', 'src/other.ts']);
    const draftA = 'A talks about @src/app.ts';
    const draftB = 'B talks about @src/other.ts';

    let reportedA: PersistedMentionRange[] = [];
    await render({
      value: draftA,
      draftKey: 'A',
      onRanges: (ranges) => {
        reportedA = toPersistedMentionRanges(ranges as never);
      },
    });
    expect(kinds()).toContain('file');

    // Switching sessions swaps text + persisted ranges without remounting.
    await render({ value: draftB, persisted: reportedA, draftKey: 'B' });
    const spans = Array.from(container.querySelectorAll('[data-mention-value]')).map((node) =>
      node.getAttribute('data-mention-value')
    );
    expect(spans).not.toContain('src/app.ts');
    expect(spans).toContain('src/other.ts');
  });

  it('restores the range when the file index IS warm on return', async () => {
    const text = 'look at @src/app.ts thanks';
    knownFileTokens = new Set(['src/app.ts']);

    let reported: PersistedMentionRange[] = [];
    await render({
      value: text,
      onRanges: (ranges) => {
        reported = toPersistedMentionRanges(ranges as never);
      },
    });
    expect(reported).toHaveLength(1);

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await render({ value: text, persisted: reported });
    expect(kinds()).toContain('file');
  });

  // The composer alone is not the whole contract: the session composer seeds
  // its ranges from a module cache and swaps them in a render-phase branch, so
  // the round trip is only proven with that wiring in place.
  it('survives a session round trip through the draft caches', async () => {
    draftCache.set('A', 'ping @fix-ci about it');
    draftCache.set('B', 'unrelated draft');
    sessionItems = [
      { sessionId: 'sess_fix', title: 'Fix CI', slug: 'fix-ci', activityAt: 1 } as never,
    ];

    const show = async (sessionId: string) => {
      await act(async () => {
        root.render(<FakeSessionComposer sessionId={sessionId} />);
      });
    };

    await show('A');
    expect(kinds()).toContain('session');
    expect(rangeCache.get('A')).toHaveLength(1);

    await show('B');
    expect(kinds()).not.toContain('session');
    expect(rangeCache.get('A')).toHaveLength(1);

    await show('A');
    expect(kinds()).toContain('session');
  });
});
