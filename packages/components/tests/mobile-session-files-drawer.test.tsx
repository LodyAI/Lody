// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileFileViewerDrawer } from '../src/components/mobile/mobile-file-viewer-drawer';
import { MobileSessionFilesDrawer } from '../src/components/mobile/mobile-session-files-drawer';
import { createFakeFileWorkspaceProvider } from '../src/lib/file-workspace-provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

vi.mock('../src/lib/native-platform', () => ({
  isNativeAppShell: () => false,
  isNativeIOSAppShell: () => false,
}));

// The Files drawer delegates files to the session viewer and never reaches
// the browser's in-place preview; keep Monaco out of the module graph.
vi.mock('../src/components/sessions/session-monaco-text-viewer', () => ({
  SessionMonacoTextViewer: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const provider = createFakeFileWorkspaceProvider({
  files: [
    { path: 'src/index.ts', kind: 'text', sourceState: 'live-collaborative' },
    { path: 'README.md', kind: 'text', sourceState: 'live-collaborative' },
  ],
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* The session's wiring: the Files drawer delegates a tapped file to the
   session viewer drawer, which `handleOpenFile` opens. */
function SessionFilesHost() {
  const [filesOpen, setFilesOpen] = useState(true);
  const [openedPath, setOpenedPath] = useState<string | null>(null);
  return (
    <>
      {openedPath ? (
        <MobileFileViewerDrawer
          open
          onOpenChange={(open) => {
            if (!open) setOpenedPath(null);
          }}
          filePath={openedPath}
          onCopyPath={() => {}}
        >
          <p>Viewer body</p>
        </MobileFileViewerDrawer>
      ) : null}
      <MobileSessionFilesDrawer
        open={filesOpen}
        onOpenChange={setFilesOpen}
        provider={provider}
        onOpenFile={setOpenedPath}
      />
    </>
  );
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function dialogs(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')];
}

function filesDialog(): HTMLElement | undefined {
  return dialogs().find((dialog) => dialog.textContent?.includes('Files'));
}

function rowButton(scope: HTMLElement, name: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-hidden') !== 'true' &&
      !candidate.closest('[aria-hidden="true"]') &&
      candidate.textContent?.trim() === name
  );
  if (!button) throw new Error(`No visible row named ${name}`);
  return button;
}

function backButton(scope: HTMLElement): HTMLButtonElement {
  const button = scope.querySelector<HTMLButtonElement>('header button[aria-label="Back"]');
  if (!button) throw new Error('No header Back button');
  return button;
}

describe('MobileSessionFilesDrawer', () => {
  it('returns from an opened file to the folder it was opened from', async () => {
    act(() => root.render(<SessionFilesHost />));
    await flush();

    const files = filesDialog();
    if (!files) throw new Error('Files drawer did not open');
    act(() => rowButton(files, 'src').click());
    await flush();
    act(() => rowButton(files, 'index.ts').click());
    await flush();

    // The viewer stacks above the still-open Files drawer: same z rung, later portal.
    const viewer = dialogs().find((dialog) => dialog.textContent?.includes('Viewer body'));
    if (!viewer) throw new Error('Viewer drawer did not open');
    expect(files.getAttribute('data-state')).toBe('open');
    expect(files.compareDocumentPosition(viewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => backButton(viewer).click());
    await flush();

    expect(dialogs().some((dialog) => dialog.textContent?.includes('Viewer body'))).toBe(false);
    expect(files.getAttribute('data-state')).toBe('open');
    expect(rowButton(files, 'index.ts')).toBeTruthy();

    // Back then drills out one level, and only closes the drawer at the root.
    act(() => backButton(files).click());
    await flush();
    expect(rowButton(files, 'README.md')).toBeTruthy();
    act(() => backButton(files).click());
    await flush();
    expect(files.getAttribute('data-state')).toBe('closed');
  });
});
