// @vitest-environment jsdom
// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DocumentSelection } from '../src/lib/document-selection';
import {
  DocumentCaptureButton,
  DocumentSelectionSurface,
  useDocumentSelection,
} from '../src/components/sessions/document-selection-surface';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

describe('document selection ownership', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === label || element.getAttribute('aria-label') === label
    )!;
  function Picker({ read }: { read: (signal: AbortSignal) => Promise<DocumentSelection> }) {
    const select = useDocumentSelection();
    return createElement(
      'button',
      { disabled: !select, onClick: () => select?.(read) },
      'Pick cells'
    );
  }
  const render = async (
    child: ReactNode,
    source = 'revision-1',
    active = true,
    onAdd: (selection: DocumentSelection) => boolean = () => true
  ) => {
    await act(async () =>
      root.render(
        <DocumentSelectionSurface path="report.xlsx" source={source} active={active} onAdd={onAdd}>
          {child}
        </DocumentSelectionSurface>
      )
    );
  };
  it.each(['source', 'hidden'] as const)(
    'discards a late selection when the %s changes',
    async (change) => {
      let finish!: (value: DocumentSelection) => void;
      let signal!: AbortSignal;
      const pending = new Promise<DocumentSelection>((resolve) => {
        finish = resolve;
      });
      const child = createElement(Picker, {
        read: (current) => {
          signal = current;
          return pending;
        },
      });
      await render(child);
      await act(async () => button('Pick cells').click());
      await render(child, change === 'source' ? 'revision-2' : 'revision-1', change !== 'hidden');
      expect(signal.aborted).toBe(true);
      await act(async () => finish({ path: 'report.xlsx', location: 'A1', text: 'old selection' }));
      expect(container.textContent).not.toContain('old selection');
      expect(container.querySelector('[aria-label="Selection annotation"]')).toBeNull();
    }
  );
  it('retains a rejected selection for retry and clears it only after handoff', async () => {
    let accepted = false;
    const received: DocumentSelection[] = [];
    await render(
      createElement(Picker, {
        read: async () => ({ path: 'report.xlsx', location: 'A1', text: 'North' }),
      }),
      'revision-1',
      true,
      (selection) => {
        if (!accepted) return false;
        received.push(selection);
        return true;
      }
    );
    await act(async () => button('Pick cells').click());
    await act(async () => button('Add to chat').click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('North');
    accepted = true;
    await act(async () => button('Add to chat').click());
    expect(received).toEqual([{ path: 'report.xlsx', location: 'A1', text: 'North', comment: '' }]);
    expect(container.querySelector('[aria-label="Selection annotation"]')).toBeNull();
  });
  it('cancels region mode with Escape without staging any content', async () => {
    await render(createElement(DocumentCaptureButton));
    await act(async () => button('Select screenshot area').click());
    const overlay = container.querySelector<HTMLElement>('[data-document-selection-overlay]')!;
    expect(document.activeElement).toBe(overlay);
    await act(async () =>
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(container.querySelector('[data-document-selection-overlay]')).toBeNull();
    expect(container.querySelector('[aria-label="Selection annotation"]')).toBeNull();
  });
});
