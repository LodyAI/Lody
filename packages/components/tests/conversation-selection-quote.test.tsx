// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatSelectionQuote,
  MAX_SELECTION_QUOTE_TEXT,
  selectionQuoteLabel,
} from '../src/lib/conversation-selection-quote';
import {
  SelectionQuoteBar,
  useSelectionQuote,
} from '../src/components/ai-gui/selection-quote';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, values?: Record<string, string>) =>
      values ? fallback.replace('{{text}}', values.text ?? '') : fallback,
  }),
}));

describe('conversation selection quotes', () => {
  it('quotes every selected line and rejects empty or over-budget prose', () => {
    expect(formatSelectionQuote({ text: '  keep the total\n\nand the note  ' })).toBe(
      'Message selection\nSelected content:\n> keep the total\n>\n> and the note'
    );
    expect(() => formatSelectionQuote({ text: '   ' })).toThrow(RangeError);
    expect(() =>
      formatSelectionQuote({ text: 'x'.repeat(MAX_SELECTION_QUOTE_TEXT + 1) })
    ).toThrow(RangeError);
  });
  it('labels a chip with the quote itself so several quotes stay tellable apart', () => {
    expect(selectionQuoteLabel('  keep   the total ')).toBe('keep the total');
    expect(selectionQuoteLabel('x'.repeat(40))).toBe(`${'x'.repeat(24)}…`);
  });
});

describe('selection quote capture', () => {
  let root: Root;
  let host: HTMLDivElement;
  const owned: string[] = [];
  const quoted: string[] = [];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    owned.length = 0;
    quoted.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    document.getSelection()?.removeAllRanges();
    host.remove();
    vi.unstubAllGlobals();
  });

  function Probe() {
    const { quoteText, clear } = useSelectionQuote({
      scopeId: 'session-1',
      enabled: true,
      history: { indexOf: (id) => owned.indexOf(id) },
    });
    return (
      <>
        {['turn-1', 'turn-2'].map((turnId) => (
          <div key={turnId} data-conversation-row-key={turnId} data-conversation-turn-id={turnId}>
            <span>{turnId} prose</span>
          </div>
        ))}
        <SelectionQuoteBar
          quote={quoteText}
          onQuote={(text) => quoted.push(text)}
          onDismiss={clear}
        />
        <output>{quoteText ?? ''}</output>
      </>
    );
  }
  const output = () => host.querySelector('output')!.textContent;
  const select = (turnId: string) => {
    const text = host.querySelector(`[data-conversation-turn-id="${turnId}"] span`)!.firstChild!;
    document.getSelection()!.setBaseAndExtent(text, 0, text, turnId.length);
    document.dispatchEvent(new Event('selectionchange'));
  };
  const press = (target: Element) =>
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));

  it('captures a range inside this surface only, and survives the caret it leaves behind', async () => {
    owned.push('turn-1');
    await act(async () => root.render(<Probe />));
    await act(async () => document.dispatchEvent(new Event('selectionchange')));
    expect(output()).toBe('');
    await act(async () => select('turn-1'));
    expect(output()).toBe('turn-1');
    // Another surface's row, then this one again: the foreign range retires it.
    await act(async () => select('turn-2'));
    expect(output()).toBe('');
    await act(async () => select('turn-1'));
    expect(output()).toBe('turn-1');
    // A collapsed caret (typing, or a click into the composer) is not a new
    // selection, so the capture must outlive it.
    const caret = host.querySelector('[data-conversation-turn-id="turn-1"] span')!.firstChild!;
    await act(async () => {
      document.getSelection()!.setBaseAndExtent(caret, 2, caret, 2);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(output()).toBe('turn-1');
  });

  it('retires the capture on a press outside its own bar and keeps it on a press inside', async () => {
    owned.push('turn-1');
    await act(async () => root.render(<Probe />));
    await act(async () => select('turn-1'));
    const bar = host.querySelector('[data-selection-quote-bar]')!;
    await act(async () => press(bar.querySelector('button')!));
    expect(output()).toBe('turn-1');
    await act(async () => press(host.querySelector('[data-conversation-row-key] span')!));
    expect(output()).toBe('');
  });

  it('hands the captured prose over and dismisses on Escape', async () => {
    owned.push('turn-1');
    await act(async () => root.render(<Probe />));
    await act(async () => select('turn-1'));
    const primary = Array.from(host.querySelectorAll('button')).find(
      (element) => element.textContent === 'Quote and comment'
    )!;
    await act(async () => primary.click());
    expect(quoted).toEqual(['turn-1']);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(output()).toBe('');
  });
});
