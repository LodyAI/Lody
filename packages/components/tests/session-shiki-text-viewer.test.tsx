// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import { SessionShikiTextViewer } from '../src/components/sessions/session-shiki-text-viewer';
import { highlightStandaloneFile } from '../src/lib/standalone-file-highlighter';
import * as fileHighlighter from '../src/lib/standalone-file-highlighter';
import type { TokensResult } from 'shiki';
import { fileViewerWordWrapAtom } from '../src/atoms/settings';

vi.mock('../src/theme-provider', () => ({
  useResolvedTheme: () => 'dark',
  useActiveVSCodeTheme: () => undefined,
}));

describe('standalone Coq/Lean viewer', () => {
  it('renders escaped source, line numbers and colors across file and wrapping changes', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const store = createStore();
    const coq = '(* <script>alert(1)</script> 世界 *)\nDefinition answer : nat := 42.\n';
    const lean = '/- comment -/\ndef result : Nat := 7\n';
    await highlightStandaloneFile(coq, 'coq', undefined, 'dark');
    try {
      await act(async () =>
        root.render(
          <Provider store={store}>
            <SessionShikiTextViewer path="test.v" text={coq} language="coq" />
          </Provider>
        )
      );
      expect([...host.querySelectorAll('code')].map((node) => node.textContent).join('')).toBe(coq);
      expect(host.querySelector('script')).toBeNull();
      expect(
        [...host.querySelectorAll('[aria-hidden="true"]')].map((node) => node.textContent)
      ).toEqual(['1', '2', '3']);
      expect(host.querySelector('code span')?.getAttribute('style')).toContain('color:');
      const wrappedClass = host.querySelector('code')?.className;
      await act(async () => {
        store.set(fileViewerWordWrapAtom, false);
      });
      expect(host.querySelector('code')?.className).not.toBe(wrappedClass);
      await act(async () =>
        root.render(
          <Provider store={store}>
            <SessionShikiTextViewer path="test.lean" text={lean} language="lean" />
          </Provider>
        )
      );
      expect([...host.querySelectorAll('code')].map((node) => node.textContent).join('')).toBe(
        lean
      );
      expect(host.querySelector('pre')?.getAttribute('aria-label')).toBe('test.lean');
      expect(host.querySelector('code span')?.getAttribute('style')).toContain('color:');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('does not replace a newer file with a late highlight result', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const oldResult = await highlightStandaloneFile(
      'Definition old : nat := 1.',
      'coq',
      undefined,
      'dark'
    );
    const newResult = await highlightStandaloneFile(
      'def fresh : Nat := 2',
      'lean',
      undefined,
      'dark'
    );
    let resolveOld!: (value: TokensResult) => void;
    const pending = new Promise<TokensResult>((resolve) => {
      resolveOld = resolve;
    });
    const highlight = vi
      .spyOn(fileHighlighter, 'highlightStandaloneFile')
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(newResult);
    try {
      await act(async () =>
        root.render(
          <SessionShikiTextViewer path="old.v" text="Definition old : nat := 1." language="coq" />
        )
      );
      await act(async () =>
        root.render(
          <SessionShikiTextViewer path="fresh.lean" text="def fresh : Nat := 2" language="lean" />
        )
      );
      await act(async () => {
        resolveOld(oldResult);
        await pending;
      });
      expect([...host.querySelectorAll('code')].map((node) => node.textContent).join('')).toBe(
        'def fresh : Nat := 2'
      );
      expect(host.querySelector('pre')?.getAttribute('aria-label')).toBe('fresh.lean');
    } finally {
      act(() => root.unmount());
      highlight.mockRestore();
    }
  });
});
