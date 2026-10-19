/** @vitest-environment jsdom */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import {
  SessionMobileDiffDrawer,
  type MobileDiffView,
} from '../src/components/sessions/session-mobile-diff-drawer';
import type { SessionChangesSidebarProps } from '../src/components/sessions/session-changes-sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entries = [
  { filePath: 'src/setup.ts', add: 26, del: 21 },
  { filePath: 'docs/setup.md', add: 30, del: 0 },
  { filePath: 'tests/setup.test.ts', add: 16, del: 0 },
];
const paths = entries.map((entry) => entry.filePath);

describe('mobile changes navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (
    view: MobileDiffView,
    options: {
      changes?: Partial<SessionChangesSidebarProps>;
      children?: ReactNode;
      onBack?: () => void;
    } = {}
  ) => {
    act(() =>
      root.render(
        <SessionMobileDiffDrawer
          open
          onOpenChange={() => {}}
          view={view}
          onBackToFiles={options.onBack ?? (() => {})}
          changes={{
            ready: true,
            synced: true,
            changeEntries: entries,
            changeFilePaths: paths,
            onOpenChangesDiff: () => {},
            ...options.changes,
          }}
        >
          {options.children ?? <textarea aria-label="Draft comment" />}
        </SessionMobileDiffDrawer>
      )
    );
  };
  const button = (text: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (node) => node.textContent?.trim() === text
    )!;

  it('shows the existing categories and totals before mounting any diff', () => {
    function Diff() {
      return <div>Diff body</div>;
    }
    render('files', { children: <Diff /> });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('+72');
    expect(dialog.textContent).toContain('−21');
    for (const title of ['Code', 'Docs', 'Tests', 'Types', 'Files']) {
      expect(dialog.textContent).toContain(title);
    }
    expect(dialog.textContent).not.toContain('Diff body');
  });

  it('selects the exact path and complete file set in both list modes', () => {
    const selected: Array<{ path: string; paths: string[] }> = [];
    render('files', {
      changes: {
        onOpenChangesDiff: (path, filePaths) => selected.push({ path, paths: filePaths }),
      },
    });
    const row = () => document.querySelector<HTMLButtonElement>('[title="docs/setup.md"]')!;
    act(() => row().click());
    expect(selected).toEqual([{ path: 'docs/setup.md', paths }]);
    act(() => button('Files').click());
    const treeRow = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (node) => node.textContent?.includes('setup.md') && !node.querySelector('[role="treeitem"]')
    )!;
    act(() => treeRow.click());
    expect(selected).toEqual([
      { path: 'docs/setup.md', paths },
      { path: 'docs/setup.md', paths },
    ]);
  });

  it('keeps the diff draft and chosen list mode while returning between levels', () => {
    render('files');
    act(() => button('Files').click());
    render('diff');
    const draft = document.querySelector<HTMLTextAreaElement>('textarea')!;
    draft.value = 'Keep this comment';
    render('files-with-diff');
    expect(document.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('Keep this comment');
    expect(draft.closest('[inert]')).not.toBeNull();
    expect(document.querySelector('[role="tree"]')).not.toBeNull();
    render('diff');
    expect(document.querySelector('textarea')).toBe(draft);
    expect(draft.closest('[inert]')).toBeNull();
  });

  it('keeps missing stats unknown and retains the existing loading/error states', () => {
    render('files', { changes: { changeEntries: [{ filePath: 'src/setup.ts' }] } });
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('--');
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('+0');
    render('files', { changes: { ready: false } });
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Loading changes');
    render('files', { changes: { unavailableMessage: 'Owner machine unavailable' } });
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'Owner machine unavailable'
    );
  });

  it('opens a direct diff without adding a file-list step', () => {
    act(() =>
      root.render(
        <SessionMobileDiffDrawer
          open
          onOpenChange={() => {}}
          changes={{
            ready: true,
            synced: true,
            changeEntries: entries,
            changeFilePaths: paths,
            onOpenChangesDiff: () => {},
          }}
        >
          <textarea aria-label="Direct diff comment" />
        </SessionMobileDiffDrawer>
      )
    );
    expect(document.querySelector('textarea')!.closest('[inert]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('Types');
    expect(button('Back')).toBeUndefined();
  });

  it('returns to the file list without closing the diff drawer', () => {
    function Navigation() {
      const [view, setView] = useState<MobileDiffView>('diff');
      return (
        <SessionMobileDiffDrawer
          open
          view={view}
          onOpenChange={() => {}}
          onBackToFiles={() => setView('files-with-diff')}
          changes={{
            ready: true,
            synced: true,
            changeEntries: entries,
            changeFilePaths: paths,
            onOpenChangesDiff: () => {},
          }}
        >
          <textarea aria-label="Draft comment" />
        </SessionMobileDiffDrawer>
      );
    }
    act(() => root.render(<Navigation />));
    act(() => button('Back').click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const row = document.querySelector('[title="docs/setup.md"]')!;
    expect(row.closest('[inert]')).toBeNull();
    expect(document.querySelector('textarea')!.closest('[inert]')).not.toBeNull();
  });
});
