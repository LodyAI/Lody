// @vitest-environment jsdom
// @vitest-environment jsdom
import { createHistoryWriter } from '@lody/shared';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderToString } from 'katex';
import { selectedMessageMarkdown } from '../src/components/ai-gui/message-quote-markdown';
import 'katex/contrib/copy-tex';
import { useConversationStreamItems } from '../src/hooks/use-conversation-stream-items';
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
  const elements = viewport.querySelectorAll('[data-conversation-row-key] > span');
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

it('copies and retains local input without inventing history, and releases it on removal', async () => {
  const doc = reimport(buildSessionDoc([]));
  const view = await openReaderView(doc, { sessionId: FIXTURE_SESSION_ID });
  dispose = () => {
    view.dispose();
    doc.free();
  };
  const rows = [{ ...row('local-input', -1), local: true }];
  await act(async () => root.render(<Probe rows={rows} view={view} />));
  await act(async () => select(0));
  const copy = new Event('copy', { bubbles: true, cancelable: true });
  await act(async () => viewport.dispatchEvent(copy));
  expect(copy.defaultPrevented).toBe(false);
  expect(document.getSelection()!.toString()).toContain('local-input original prose');
  expect(state.keepMounted).toEqual([1]);
  expect(state.holds.has('local-input')).toBe(true);
  expect(state.holds.get('local-input')).toBeUndefined();
  expect(view.turnCount).toBe(0);
  await act(async () => root.render(<Probe rows={[]} view={view} />));
  expect(state.keepMounted).toEqual([]);
  expect(document.getSelection()!.isCollapsed).toBe(true);
});

it('blocks formula clipboard conversion until every selected row is ready', async () => {
  const rows = [row('a', 0), row('loading', 1, false), row('c', 2)];
  await act(async () => root.render(<Probe rows={rows} />));
  viewport.querySelector('span')!.insertAdjacentHTML('beforeend', renderToString('x^2'));
  await act(async () => select(0, 2));
  const contents = new Map<string, string>();
  const copy = () => {
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (format: string, value: string) => contents.set(format, value) },
    });
    viewport.dispatchEvent(event);
  };

  await act(async () => copy());
  expect(contents.size).toBe(0);
  expect(viewport.querySelector('output')!.textContent).toBe('copy incomplete');

  await act(async () => root.render(<Probe rows={rows.map((r) => ({ ...r, ready: true }))} />));
  await act(async () => copy());
  expect(contents.get('text/plain')).toContain('$x^2$');
  expect(contents.get('text/plain')).toContain('loading original prose');
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

it('keeps a selected turn pinned and its node in place when a later turn lands', async () => {
  const doc = reimport(buildSessionDoc(buildFixtureHistory(20)));
  const view = await openReaderView(doc, {
    sessionId: FIXTURE_SESSION_ID,
    maxHydrated: 1,
    tailKeep: 0,
    scheduleIdle: createManualIdle().scheduleIdle,
    yieldToEventLoop: () => Promise.resolve(),
  });
  const writer = createHistoryWriter(doc);
  dispose = () => {
    view.dispose();
    doc.free();
  };
  const [selected, landed] = buildFixtureHistory(1).map((entry, i) => ({
    ...entry,
    id: i === 0 ? 'selected-turn' : 'landed-turn',
  }));
  writer.append(selected!);
  await flushReaderChanges();
  const rows = [row(selected!.id, view.indexOf(selected!.id))];
  await act(async () => root.render(<Probe rows={rows} view={view} />));
  await act(async () => select(0));
  const anchor = document.getSelection()!.anchorNode;
  await act(async () => {
    writer.append(landed!);
    await flushReaderChanges();
  });
  await act(async () => root.render(<Probe rows={rows} view={view} />));
  expect(view.indexOf(landed!.id)).toBe(view.turnCount - 1);
  const distant = view.acquireRange(0, 10);
  await distant.ready;
  expect(view.isHydrated(view.indexOf(selected!.id))).toBe(true);
  expect(document.getSelection()!.anchorNode).toBe(anchor);
  expect(anchor!.isConnected).toBe(true);
  await act(async () => {
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(view.isHydrated(view.indexOf(selected!.id))).toBe(false);
  distant.release();
});

it('keeps selected stream bodies rendered after the reading window moves, then releases them', async () => {
  const doc = reimport(buildSessionDoc(buildFixtureHistory(100)));
  const idle = createManualIdle();
  const view = await openReaderView(doc, {
    sessionId: FIXTURE_SESSION_ID,
    maxHydrated: 8,
    tailKeep: 2,
    scheduleIdle: idle.scheduleIdle,
    yieldToEventLoop: () => Promise.resolve(),
  });
  dispose = () => view.dispose();
  let stream!: ReturnType<typeof useConversationStreamItems>;
  function StreamProbe() {
    stream = useConversationStreamItems(view, FIXTURE_SESSION_ID);
    const activeRef = useRef(false);
    const virtualizer = useRef(null);
    const rows = stream.items.flatMap((item) =>
      item.type === 'empty'
        ? []
        : [
            {
              key: item.type === 'message' ? item.message.id : item.row.id,
              turnId: item.type === 'message' ? item.message.id : item.row.id,
              turnIndex: item.turnIndex,
              ready: item.type === 'message',
            },
          ]
    );
    useConversationTextSelection({
      sessionId: FIXTURE_SESSION_ID,
      view,
      rows,
      viewport,
      virtualizer,
      activeRef,
      leadingRowCount: 0,
      captureTurn: (id) => id,
      onChange: stream.onRetainedTurnIdsChange,
      onRelease: noop,
      onCopyUnavailable: noop,
    });
    return (
      <>
        {rows.map((itemRow) => (
          <div key={itemRow.key} data-conversation-row-key={itemRow.key}>
            <span>{itemRow.ready ? `body:${itemRow.turnId}` : 'placeholder'}</span>
          </div>
        ))}
      </>
    );
  }
  await act(async () => root.render(<StreamProbe />));
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  await act(async () => stream.onVisibleTurnRangeChange({ from: 20, to: 28 }));
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  await act(async () => select(21));
  const before = viewport.querySelector('[data-conversation-row-key="a-10"] span')!.firstChild;
  expect(document.getSelection()!.toString()).toBe('body:a-10');
  await act(async () => stream.onVisibleTurnRangeChange({ from: 100, to: 108 }));
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(document.getSelection()!.toString()).toBe('body:a-10');
  expect(viewport.querySelector('[data-conversation-row-key="a-10"] span')!.firstChild).toBe(
    before
  );
  await act(async () => {
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(viewport.querySelector('[data-conversation-row-key="a-10"]')!.textContent).toBe(
    'placeholder'
  );
});

it('keeps formatting and link targets across selected text regions', () => {
  const area = document.createElement('div');
  area.innerHTML = `<div data-message-quote-text><p>Before <strong>important</strong> <a href="https://example.com/path">guide</a></p><ul><li>first</li><li>second</li></ul></div><div data-message-quote-text><p>After <em>emphasis</em></p></div>`;
  host.append(area);
  const first = area.querySelector('strong')!.firstChild!;
  const last = area.querySelector('em')!.firstChild!;
  const range = document.createRange();
  range.setStart(first, 3);
  range.setEnd(last, 4);
  expect(selectedMessageMarkdown(range, area)).toBe(
    '**ortant** [guide](https://example.com/path)\n\n* first\n* second\n\nAfter *emph*'
  );
});

it('retains code lines, table structure and selected math source', () => {
  const area = document.createElement('div');
  area.innerHTML = `<div data-message-quote-text><div data-streamdown="code-block" data-language="ts"><div data-streamdown="code-block-toolbar">TypeScript<button>Copy</button></div><pre><code><span data-markdown-code-line>const a = 1;</span><span data-markdown-code-line>const b = 2;</span></code></pre></div><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table><p>${renderToString('\\frac{x}{2}', { output: 'htmlAndMathml' })}</p></div>`;
  host.append(area);
  const range = document.createRange();
  range.selectNodeContents(area.querySelector('[data-message-quote-text]')!);
  const markdown = selectedMessageMarkdown(range, area);
  expect(markdown).toContain('```ts\nconst a = 1;\nconst b = 2;\n```');
  expect(markdown).toContain('| Name | Value |');
  expect(markdown).toContain('| A    | B     |');
  expect(markdown).toContain('$\\frac{x}{2}$');
  expect(markdown).not.toContain('TypeScript');
  const secondLine = area.querySelectorAll('[data-markdown-code-line]')[1]!.firstChild!;
  range.setStart(secondLine, 0);
  range.setEnd(secondLine, 7);
  expect(selectedMessageMarkdown(range, area)).toBe('```ts\nconst b\n```');
});

it('preserves numbered list positions and expands a partial formula selection', () => {
  const area = document.createElement('div');
  area.innerHTML = `<div data-message-quote-text><ol start="4"><li>first</li><li>second</li></ol><p>${renderToString('\\frac{x}{2}', { output: 'htmlAndMathml' })}</p></div>`;
  host.append(area);
  const range = document.createRange();
  const second = area.querySelectorAll('li')[1]!.firstChild!;
  range.setStart(second, 0);
  range.setEnd(second, second.textContent!.length);
  expect(selectedMessageMarkdown(range, area)).toBe('5. second');
  const mathText = area.querySelector('.katex-html .mord')!.firstChild!;
  range.selectNodeContents(mathText);
  expect(selectedMessageMarkdown(range, area)).toBe('$\\frac{x}{2}$');
});
