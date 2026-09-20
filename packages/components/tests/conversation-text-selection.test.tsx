// @vitest-environment jsdom
import { createHistoryWriter, type WorkspaceId } from '@lody/shared';
import { createProjectedConversationView } from '../src/lib/conversation-view/projected-conversation-view';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConversationView } from '../src/lib/conversation-view';
import {
  NativeTextSelectionHoldContext,
  useConversationTextSelection,
  useSelectionStableValue,
  type SelectableConversationRow,
} from '../src/hooks/use-conversation-text-selection';
import {
  flushReaderChanges,
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
  openReaderView,
  reimport,
} from './conversation-view-fixtures';

let root: Root;
let host: HTMLDivElement;
let viewport: HTMLDivElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  viewport = document.createElement('div');
  host.append(viewport);
  document.body.append(host);
  root = createRoot(viewport);
});
afterEach(() => {
  act(() => root.unmount());
  document.getSelection()?.removeAllRanges();
  dispose?.();
  dispose = undefined;
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const noop = () => {};
let state: ReturnType<typeof useConversationTextSelection<string>>;
function StableText({ text }: { text: string }) {
  return <span>{useSelectionStableValue(text)}</span>;
}
function Probe({
  rows,
  view,
  text = 'original prose',
}: {
  rows: SelectableConversationRow[];
  view?: ConversationView;
  text?: string;
}) {
  const active = useRef(false);
  const virtualizer = useRef(null);
  const [error, setError] = useState('');
  state = useConversationTextSelection({
    sessionId: 'selection-test',
    view,
    rows,
    viewport,
    virtualizer,
    leadingRowCount: 1,
    activeRef: active,
    captureTurn: (id) => id,
    onChange: noop,
    onRelease: noop,
    onCopyUnavailable: () => setError('copy incomplete'),
  });
  return (
    <>
      {rows.map((row) => (
        <div key={row.key} data-conversation-row-key={row.key}>
          <NativeTextSelectionHoldContext.Provider value={state.holds.has(row.turnId)}>
            <StableText text={row.key + ' ' + text} />
          </NativeTextSelectionHoldContext.Provider>
        </div>
      ))}
      <output>{error}</output>
    </>
  );
}
function select(from: number, to = from) {
  const elements = viewport.querySelectorAll('[data-conversation-row-key] span');
  const first = elements[from]!.firstChild!;
  const last = elements[to]!.firstChild!;
  document.getSelection()!.setBaseAndExtent(first, 0, last, last.textContent!.length);
  document.dispatchEvent(new Event('selectionchange'));
}
const row = (key: string, turnIndex: number, ready = true): SelectableConversationRow => ({
  key,
  turnId: key,
  turnIndex,
  ready,
});

it('retains the complete interval after pointerup and holds prose until selection clears', async () => {
  const rows = [row('a', 0), row('b', 1), row('c', 2)];
  await act(async () => root.render(<Probe rows={rows} />));
  const originalNode = viewport.querySelector('span')!.firstChild;
  await act(async () => {
    viewport.querySelector('span')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    select(0, 2);
    document.dispatchEvent(new Event('pointerup'));
  });
  expect(state.keepMounted).toEqual([1, 2, 3]);
  await act(async () => root.render(<Probe rows={rows} text="updated prose" />));
  expect(document.getSelection()!.toString()).toBe(
    'a original proseb original prosec original prose'
  );
  expect(viewport.querySelector('span')!.firstChild).toBe(originalNode);
  await act(async () => {
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(state.keepMounted).toEqual([]);
  expect(state.activeRef.current).toBe(false);
  expect(viewport.textContent).toContain('updated prose');
});

it('pins real history bodies before the viewport lease releases, then allows eviction', async () => {
  const doc = reimport(buildSessionDoc(buildFixtureHistory(20)));
  const view = await openReaderView(doc, {
    sessionId: FIXTURE_SESSION_ID,
    maxHydrated: 1,
    tailKeep: 0,
    scheduleIdle: createManualIdle().scheduleIdle,
    yieldToEventLoop: () => Promise.resolve(),
  });
  dispose = () => {
    view.dispose();
    doc.free();
  };
  const head = view.acquireRange(0, 3);
  await head.ready;
  const rows = Array.from({ length: 3 }, (_, i) => row(view.index(i)!.id, i));
  await act(async () => root.render(<Probe rows={rows} view={view} />));
  await act(async () => select(0, 2));
  head.release();
  const distant = view.acquireRange(30, 35);
  await distant.ready;
  expect([0, 1, 2].map((i) => view.isHydrated(i))).toEqual([true, true, true]);
  await act(async () => {
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect([0, 1, 2].filter((i) => view.isHydrated(i)).length).toBeLessThan(3);
  distant.release();
});

it('blocks incomplete native copy without replacing clipboard contents and recovers after loading', async () => {
  const rows = [row('a', 0), row('loading', 1, false), row('c', 2)];
  await act(async () => root.render(<Probe rows={rows} />));
  await act(async () => select(0, 2));
  const copy = new Event('copy', { bubbles: true, cancelable: true });
  await act(async () => viewport.dispatchEvent(copy));
  expect(copy.defaultPrevented).toBe(true);
  expect(viewport.querySelector('output')!.textContent).toBe('copy incomplete');
  await act(async () => root.render(<Probe rows={rows.map((r) => ({ ...r, ready: true }))} />));
  const retry = new Event('copy', { bubbles: true, cancelable: true });
  await act(async () => viewport.dispatchEvent(retry));
  expect(retry.defaultPrevented).toBe(false);
  expect(document.getSelection()!.toString()).toContain('loading original prose');
});

it('keeps a touch-cancelled provisional turn until the native range arrives', async () => {
  const rows = [row('a', 0), row('b', 1)];
  await act(async () => root.render(<Probe rows={rows} />));
  await act(async () => {
    viewport.querySelector('span')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.dispatchEvent(new Event('pointercancel'));
  });
  expect(state.keepMounted).toEqual([1]);
  await act(async () => select(0));
  expect(state.activeRef.current).toBe(true);
  await act(async () => {
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(state.keepMounted).toEqual([]);
});

it('releases a cancelled touch candidate when scrolling produces no native selection', async () => {
  const rows = [row('a', 0)];
  await act(async () => root.render(<Probe rows={rows} />));
  await act(async () => {
    viewport.querySelector('span')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.dispatchEvent(new Event('pointercancel'));
    viewport.dispatchEvent(new Event('scroll'));
  });
  expect(state.keepMounted).toEqual([]);
  expect(state.activeRef.current).toBe(false);
  await act(async () => root.render(<Probe rows={rows} text="live update" />));
  expect(viewport.textContent).toContain('live update');
});

it('pins an optimistic turn when it becomes authoritative without replacing its selected node', async () => {
  const doc = reimport(buildSessionDoc(buildFixtureHistory(20)));
  const base = await openReaderView(doc, {
    sessionId: FIXTURE_SESSION_ID,
    maxHydrated: 1,
    tailKeep: 0,
    scheduleIdle: createManualIdle().scheduleIdle,
    yieldToEventLoop: () => Promise.resolve(),
  });
  const writer = createHistoryWriter(doc);
  dispose = () => {
    base.dispose();
    doc.free();
  };
  const entry = { ...buildFixtureHistory(1)[0]!, id: 'accepted-turn' };
  const view = createProjectedConversationView(base, [
    {
      workspaceId: 'test-workspace' as WorkspaceId,
      sessionId: FIXTURE_SESSION_ID,
      entry,
    },
  ]);
  const rows = [row(entry.id, view.indexOf(entry.id))];
  await act(async () => root.render(<Probe rows={rows} view={view} />));
  await act(async () => select(0));
  const anchor = document.getSelection()!.anchorNode;
  await act(async () => {
    writer.append(entry);
    await flushReaderChanges();
  });
  await act(async () => root.render(<Probe rows={rows} view={base} />));
  const distant = base.acquireRange(0, 10);
  await distant.ready;
  expect(base.isHydrated(base.indexOf(entry.id))).toBe(true);
  expect(document.getSelection()!.anchorNode).toBe(anchor);
  expect(anchor!.isConnected).toBe(true);
  await act(async () => {
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(base.isHydrated(base.indexOf(entry.id))).toBe(false);
  distant.release();
});
