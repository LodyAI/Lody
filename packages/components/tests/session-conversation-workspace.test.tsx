// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import { SessionConversationWorkspace } from '../src/components/sessions/session-conversation-workspace';
import { useConversationPane } from '../src/components/sessions/conversation-pane-context';

const controllers = new Map<string, NonNullable<ReturnType<typeof useConversationPane>>>();
const navigation = vi.hoisted(() => ({ visit: (_: unknown) => {} }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigation.visit }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../src/atoms/doc-meta', () => ({
  sessionListAtom: atom([
    { id: 'a', title: 'Alpha', lastMessageAt: 2 },
    { id: 'b', title: 'Beta', lastMessageAt: 1 },
    { id: 'c', title: 'Gamma', lastMessageAt: 0 },
  ]),
}));
vi.mock('../src/lib/session-draft-tabs', () => ({ readStoredLastActiveTabState: () => null }));
vi.mock('../src/components/chat/chat-landing', () => ({
  ChatLanding: ({ onSessionCreated }: { onSessionCreated: (id: SessionId) => void }) => (
    <button onClick={() => onSessionCreated('new-session' as SessionId)}>Send first message</button>
  ),
}));
// Keep the real column layout and navigation owner; substitute the expensive session/runtime leaf.
vi.mock('../src/components/sessions/session-detail', () => ({
  default: ({ sessionId, urlTab }: { sessionId: string; urlTab?: string }) => {
    const pane = useConversationPane()!;
    controllers.set(sessionId, pane);
    const [draft, setDraft] = useState('');
    return (
      <div data-session={sessionId} data-tab={urlTab ?? 'parent'}>
        {pane.actions}
        <input
          aria-label={`Draft ${sessionId}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button onClick={() => pane.setTab(`session:${sessionId}-child`, { push: true })}>
          Child {sessionId}
        </button>
      </div>
    );
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let externalVisit: (id: string, tab?: string) => void;
function Harness() {
  const [route, setRoute] = useState({ sessionId: 'a', search: {} as { tab?: string } });
  navigation.visit = (value) => {
    const next = value as { params: { sessionId: string }; search: { tab?: string } };
    setRoute({ sessionId: next.params.sessionId, search: next.search });
  };
  externalVisit = (sessionId, tab) => setRoute({ sessionId, search: { tab } });
  return (
    <SessionConversationWorkspace
      workspaceSlug="workspace"
      sessionId={route.sessionId as SessionId}
      search={route.search}
    />
  );
}
function pane(id: string) {
  return container.querySelector<HTMLElement>(`[data-split-pane-id="${id}"]`)!;
}
async function click(label: string, parent: ParentNode = container) {
  const button = Array.from(parent.querySelectorAll('button')).find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label
  );
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
beforeEach(async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('App conversation columns', () => {
  it('keeps the first composer mounted while another real session opens, and deduplicates repeated opens', async () => {
    const input = container.querySelector('input')!;
    await click('Split right');
    await click('Beta', pane('pane-2'));
    expect(container.querySelector('[data-session="a"] input')).toBe(input);
    expect(container.querySelectorAll('[data-session]')).toHaveLength(2);
    await click('Split right', pane('pane-2'));
    await click('AlphaOpen in another column', pane('pane-3'));
    expect(pane('pane-1').dataset.focused).toBe('true');
    expect(container.querySelectorAll('[data-session="a"]')).toHaveLength(1);
  });

  it('retains each column tab across focus changes and routes sidebar selections into the focused column', async () => {
    await click('Child a');
    await click('Split right');
    await click('Beta', pane('pane-2'));
    await click('Child b', pane('pane-2'));
    await act(async () =>
      pane('pane-1').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    );
    expect(container.querySelector('[data-session="a"]')?.getAttribute('data-tab')).toBe(
      'session:a-child'
    );
    await act(async () => externalVisit('c'));
    expect(pane('pane-1').querySelector('[data-session="c"]')).toBeTruthy();
    expect(pane('pane-2').querySelector('[data-session="b"]')?.getAttribute('data-tab')).toBe(
      'session:b-child'
    );
  });

  it('ignores delayed tab writes from a closed column', async () => {
    await click('Split right');
    await click('Beta', pane('pane-2'));
    const closedColumn = controllers.get('b')!;
    await click('Close column', pane('pane-2'));
    await act(async () => closedColumn.setTab('session:b-child', { push: true }));
    expect(container.querySelectorAll('[data-split-pane-id]')).toHaveLength(1);
    expect(container.querySelector('[data-session="a"]')?.getAttribute('data-tab')).toBe('parent');
    expect(container.querySelector('[data-session="b"]')).toBeNull();
  });

  it('keeps a new chat first send in its column and closing it returns to the surviving session', async () => {
    await click('Split right');
    await click('New chat in this column', pane('pane-2'));
    await click('Send first message', pane('pane-2'));
    expect(pane('pane-1').querySelector('[data-session="a"]')).toBeTruthy();
    expect(pane('pane-2').querySelector('[data-session="new-session"]')).toBeTruthy();
    await click('Close column', pane('pane-2'));
    expect(container.querySelectorAll('[data-split-pane-id]')).toHaveLength(1);
    expect(pane('pane-1').dataset.focused).toBe('true');
    expect(pane('pane-1').querySelector('[data-session="a"]')).toBeTruthy();
  });
});
