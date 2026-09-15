import { openReaderView, flushReaderChanges } from './conversation-view-fixtures';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroMap } from 'loro-crdt';
import { createHistoryWriter, resolveSessionConversationConfig } from '@lody/shared';
import {
  useConversationVersion,
  useConversationTail,
  useTurnRange,
} from '../src/hooks/use-conversation-view';
import { useIncrementalSearchBlocks } from '../src/hooks/use-incremental-search-blocks';
import {
  createConversationSession,
  collectConversationConfigSources,
  type ConversationView,
} from '../src/lib/conversation-view';
import type { SessionSearchBlock } from '../src/lib/session-chat-search';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
  reimport,
} from './conversation-view-fixtures';
import { useConversationStreamItems } from '../src/hooks/use-conversation-stream-items';
import { useSessionTurnFacts } from '../src/components/sessions/session-turn-facts';
import { useSessionMcpSelection } from '../src/hooks/use-session-mcp-selection';

let root: Root;
let container: HTMLDivElement;
const views: ConversationView[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  for (const view of views.splice(0)) view.dispose();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function openView(rounds: number) {
  const doc = reimport(buildSessionDoc(buildFixtureHistory(rounds)));
  const idle = createManualIdle();
  const view = await openReaderView(doc, {
    sessionId: FIXTURE_SESSION_ID,
    maxHydrated: 4,
    tailKeep: 2,
    scheduleIdle: idle.scheduleIdle,
    yieldToEventLoop: () => Promise.resolve(),
  });
  views.push(view);
  return { doc, view, idle };
}
const flush = async () => {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
};

describe('conversation view React readers', () => {
  it('holds the initial tail window until ready and never hides later window loads', async () => {
    const { view } = await openView(150);
    const acquire = view.acquireRange.bind(view);
    let releaseReady!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    vi.spyOn(view, 'acquireRange').mockImplementation((...args) => {
      const lease = acquire(...args);
      return { ...lease, ready: lease.ready.then(() => gate) };
    });
    let stream!: ReturnType<typeof useConversationStreamItems>;
    function Probe() {
      stream = useConversationStreamItems(view, FIXTURE_SESSION_ID);
      return <span>{String(stream.initialWindowReady)}</span>;
    }
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe('false');
    await act(async () => {
      stream.onVisibleTurnRangeChange({ from: 0, to: 8 });
    });
    await flush();
    expect(view.isHydrated(0)).toBe(false);
    expect(container.textContent).toBe('false');
    await act(async () => {
      releaseReady();
    });
    expect(container.textContent).toBe('true');
    await act(async () => {
      stream.onVisibleTurnRangeChange({ from: 0, to: 8 });
    });
    await flush();
    expect(view.isHydrated(0)).toBe(true);
    expect(container.textContent).toBe('true');
  });

  it("does not accept a previous view's pending initial window after switching sessions", async () => {
    const { view: first } = await openView(30);
    const { view: second } = await openView(31);
    const releases: (() => void)[] = [];
    for (const view of [first, second]) {
      const acquire = view.acquireRange.bind(view);
      const gate = new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      vi.spyOn(view, 'acquireRange').mockImplementation((...args) => {
        const lease = acquire(...args);
        return { ...lease, ready: lease.ready.then(() => gate) };
      });
    }
    function Probe({ view }: { view: ConversationView }) {
      const stream = useConversationStreamItems(view, FIXTURE_SESSION_ID);
      return <span>{String(stream.initialWindowReady)}</span>;
    }
    await act(async () => root.render(<Probe view={first} />));
    await act(async () => root.render(<Probe view={second} />));
    await act(async () => {
      releases[0]!();
    });
    expect(container.textContent).toBe('false');
    await act(async () => {
      releases[1]!();
    });
    expect(container.textContent).toBe('true');
  });

  it('rehydrates a mounted viewport after same-length replacement and releases it on unmount', async () => {
    const { doc, view, idle } = await openView(150);
    function Probe() {
      useConversationVersion(view);
      useTurnRange(view, 20, 30);
      return <span>{view.turn(20)?.id ?? 'placeholder'}</span>;
    }
    await act(async () => root.render(<Probe />));
    await flush();
    expect(container.textContent).toBe('u-10');
    await act(async () => {
      const list = doc.getList('history');
      list.delete(20, 10);
      for (let i = 0; i < 10; i++) {
        const turn = list.insertContainer(20 + i, new LoroMap());
        turn.set('id', `replacement-${i}`);
        turn.set('role', 'assistant');
      }
      doc.commit();
      await flushReaderChanges();
      idle.runAll();
    });
    await flush();
    expect(container.textContent).toBe('replacement-0');
    for (let i = 20; i < 30; i++) expect(view.isHydrated(i)).toBe(true);
    act(() => root.render(null));
    expect(
      Array.from({ length: view.turnCount }, (_, i) => view.isHydrated(i)).filter(Boolean).length
    ).toBeLessThanOrEqual(4);
  });

  it('indexes bulk appends while search remains open and releases all history on close', async () => {
    const { doc, view, idle } = await openView(1);
    let blocks: SessionSearchBlock[] = [];
    function Probe({ open }: { open: boolean }) {
      blocks = useIncrementalSearchBlocks(view, open);
      return null;
    }
    await act(async () => root.render(<Probe open />));
    const peer = reimport(doc);
    const writer = createHistoryWriter(peer);
    for (const entry of buildFixtureHistory(51).slice(2)) writer.append(entry);
    await act(async () => {
      doc.import(peer.export({ mode: 'update', from: doc.version() }));
      idle.runAll();
    });
    await flush();
    expect(new Set(blocks.map((block) => block.messageId)).size).toBe(102);
    expect(blocks.some((block) => block.messageId === 'u-1')).toBe(true);
    await act(async () => root.render(<Probe open={false} />));
    expect(blocks).toEqual([]);
    expect(
      Array.from({ length: view.turnCount }, (_, i) => view.isHydrated(i)).filter(Boolean).length
    ).toBeLessThanOrEqual(4);
  });

  it('refreshes cached search positions after insertion and deletion', async () => {
    const { doc, view } = await openView(3);
    let blocks: SessionSearchBlock[] = [];
    function Probe() {
      blocks = useIncrementalSearchBlocks(view, true);
      return null;
    }
    await act(async () => root.render(<Probe />));
    const original = view.turn(1);
    await act(async () => {
      const turn = doc.getList('history').insertContainer(0, new LoroMap());
      turn.set('id', 'prepended');
      turn.set('role', 'system');
      doc.commit();
      await flushReaderChanges();
    });
    await flush();
    expect(view.turn(2)).toEqual(original);
    expect(blocks.find((block) => block.messageId === 'a-0')?.messageIndex).toBe(2);
    await act(async () => {
      doc.getList('history').delete(0, 1);
      doc.commit();
      await flushReaderChanges();
    });
    await flush();
    expect(blocks.find((block) => block.messageId === 'a-0')?.messageIndex).toBe(1);
  });
});

vi.mock('../src/hooks/use-workspace-mcp-catalog', () => ({
  useWorkspaceMcpCatalog: () => ({ servers: CATALOG, synced: true }),
}));
const CATALOG = [{ id: 'default-mcp', name: 'Default', enabledByDefault: true }];
// Deterministic (manual idle, an explicit `yieldToEventLoop` gate, fake timers)
// but genuinely CPU-heavy: 50 turns whose assistant bodies carry 400 items each,
// mirrored and hydrated through React. It runs in ~2s idle, which leaves no room
// under Vitest's 5s default when eight workers share the machine — the timeout
// then reports as a test failure that says nothing about the behavior. The
// explicit budget below removes that machine-load dependency; it is not covering
// for a hang, since nothing here waits on wall-clock time.
const MCP_SELECTION_HYDRATION_TIMEOUT_MS = 30_000;
it.each([false, true])(
  'preserves explicit empty MCP selection after mounting composer hooks: windowed=%s',
  async (windowed) => {
    const host = container;
    const history = buildFixtureHistory(25);
    for (const turn of history)
      if (turn.role === 'assistant')
        turn.items = Array.from({ length: 400 }, () => ({ type: 'text', text: 'body' }));
    history[48]!.inputConfig = {
      ...history[48]!.inputConfig,
      agentRoleId: null,
      mcpServerIds: [],
      configOptionValues: { effort: 'high' },
      taskToolsEnabled: true,
    };
    const doc = buildSessionDoc(history);
    const idle = createManualIdle();
    let resume!: () => void;
    const gate = new Promise<void>((r) => (resume = r));
    const session = createConversationSession(doc, {
      sessionId: FIXTURE_SESSION_ID,
      windowed,
      scheduleIdle: idle.scheduleIdle,
      yieldToEventLoop: () => gate,
    });
    let sent: readonly string[] | undefined;
    let selected: readonly string[] = [];
    function Stream() {
      useConversationStreamItems(session.history, FIXTURE_SESSION_ID);
      return null;
    }
    function Composer() {
      const tail = useConversationTail(session.history, { extendToLastUserTurn: true });
      const config = resolveSessionConversationConfig(
        collectConversationConfigSources(session.history, tail.from)
      );
      useSessionTurnFacts(session.history);
      selected = useSessionMcpSelection(config.mcpServerIds, { existingSession: true }).selectedIds;
      return (
        <>
          <Stream />
          <button
            onClick={() => {
              sent = [...selected];
            }}
          >
            send
          </button>
        </>
      );
    }
    try {
      await act(async () => root.render(<Composer />));
      await act(async () => vi.runAllTimersAsync());
      act(() => host.querySelector('button')!.click());
      const before = sent;
      resume();
      await act(async () => {
        await gate;
        await Promise.resolve();
        await vi.runAllTimersAsync();
      });
      expect(selected, 'after hydration').toEqual([]);
      expect(before, 'send while range loading').toEqual([]);
    } finally {
      resume();
      await act(async () => root.render(null));
      session.history.dispose();
      session.mirror.dispose();
      doc.free();
    }
  },
  MCP_SELECTION_HYDRATION_TIMEOUT_MS
);
