// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import { SessionReadonlyContext } from '../src/components/ai-gui/session-readonly-context';
import { SessionLinkProvider } from '../src/components/ai-gui/session-link-context';
import { MarkdownFileResources } from '../src/components/ai-gui/markdown-file-image';
import {
  createFakeFileWorkspaceProvider,
  type FileWorkspaceOpenResult,
} from '../src/lib/file-workspace-provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('anonymous Markdown resource boundary', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (text: string) =>
    act(async () =>
      root.render(
        <SessionReadonlyContext.Provider
          value={{ renderImage: () => null, renderFiles: () => null }}
        >
          <MarkdownRenderer text={text} />
        </SessionReadonlyContext.Provider>
      )
    );

  it('does not load raw remote image URLs or instantiate a workspace image resolver', async () => {
    await render('![Original diagram](https://source.example/signed-image?token=synthetic)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Original diagram');
  });

  it('makes source attachment links inert while retaining ordinary explicit web navigation', async () => {
    await render(
      '[Attachment](https://api.example/api/workspaces/private/session-files/source/file)\n\n[Article](https://example.org/article)'
    );
    const links = [...container.querySelectorAll('a')];
    expect(links.some((link) => link.href.includes('/session-files/'))).toBe(false);
    expect(container.textContent).toContain('Attachment');
    expect(links.some((link) => link.href === 'https://example.org/article')).toBe(true);
  });
});

describe('conversation Markdown images across row remounts', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  // Virtua unmounts a row outside its overscan and mounts it again on return.
  const remount = async (text: string) => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<MarkdownRenderer text={text} />));
  };

  it('reserves a loaded image size on the next mount', async () => {
    const text = '![Screenshot](https://example.org/remount-loaded.png)';
    await act(async () => root.render(<MarkdownRenderer text={text} />));
    const image = container.querySelector('img')!;
    expect(image.hasAttribute('height')).toBe(false);
    Object.defineProperty(image, 'naturalWidth', { value: 1200 });
    Object.defineProperty(image, 'naturalHeight', { value: 800 });
    await act(async () => image.dispatchEvent(new Event('load')));

    await remount(text);
    const again = container.querySelector('img')!;
    expect(again.getAttribute('width')).toBe('1200');
    expect(again.getAttribute('height')).toBe('800');
  });

  it('shows an unreachable image as its alt text, and keeps it so on the next mount', async () => {
    const text = '![Local preview](/tmp/remount-unreachable.png)';
    await act(async () => root.render(<MarkdownRenderer text={text} />));
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="img"]')?.textContent).toBe('Local preview');

    await remount(text);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="img"]')?.textContent).toBe('Local preview');
  });
});

describe('file Markdown images', () => {
  let root: Root, container: HTMLDivElement;
  const blobs = new Map<string, Blob>();
  let sequence = 0;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL(blob: Blob) {
          const url = `blob:test-${++sequence}`;
          blobs.set(url, blob);
          return url;
        }
        static revokeObjectURL(url: string) {
          blobs.delete(url);
        }
      }
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    expect(blobs.size).toBe(0);
    vi.unstubAllGlobals();
  });
  const provider = () =>
    createFakeFileWorkspaceProvider({
      files: [{ path: 'images/plot.png', kind: 'binary', sourceState: 'live-readonly' }],
      snapshots: {
        'images/plot.png': { kind: 'binary', bytes: new Uint8Array([137, 80, 78, 71]) },
      },
    });
  const render = (
    source: Pick<ReturnType<typeof provider>, 'openFile'>,
    automatic = false,
    documentPath = 'docs/guide.md'
  ) =>
    act(async () =>
      root.render(
        <MarkdownFileResources
          provider={source}
          documentPath={documentPath}
          automatic={automatic}
          active
        >
          <MarkdownRenderer
            text={'# Complete document\n\n![Plot](../images/plot.png)\n\nText after the image.'}
          />
        </MarkdownFileResources>
      )
    );
  const click = () =>
    act(async () => container.querySelector<HTMLButtonElement>('button')!.click());

  it('renders all text first, reads only on click, and releases the resulting blob on close', async () => {
    const source = provider();
    const paths: string[] = [];
    await render({
      openFile: async (path) => {
        paths.push(path);
        return source.openFile(path);
      },
    });
    expect(container.textContent).toContain('Complete document');
    expect(container.textContent).toContain('Text after the image.');
    expect(container.textContent).toContain('Load image');
    expect(container.querySelector('img')).toBeNull();
    expect(paths).toEqual([]);
    await click();
    expect(paths).toEqual(['images/plot.png']);
    const img = container.querySelector('img')!;
    expect(blobs.get(img.src)?.type).toBe('image/png');
    expect(blobs.get(img.src)?.size).toBe(4);
    await act(async () => img.dispatchEvent(new Event('load')));
    expect(container.querySelector('button')).toBeNull();
  });

  it('loads same-machine resources automatically without creating a blob', async () => {
    const source = createFakeFileWorkspaceProvider({
      files: [{ path: 'images/plot.png', kind: 'binary', sourceState: 'live-readonly' }],
      snapshots: { 'images/plot.png': { kind: 'binary', url: 'lody-file://synthetic/image' } },
    });
    await render(source, true);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('lody-file://synthetic/image');
    expect(blobs.size).toBe(0);
  });

  it('shows a failed read and can retry it', async () => {
    const source = provider();
    let available = false;
    await render({
      openFile: (path) =>
        available
          ? source.openFile(path)
          : Promise.resolve({
              status: 'unavailable',
              reason: 'transient-io',
              message: 'Machine offline',
            }),
    });
    await click();
    expect(container.textContent).toContain('Machine offline');
    expect(container.textContent).toContain('Retry');
    available = true;
    await click();
    expect(container.querySelector('img')?.src).toMatch(/^blob:/);
  });

  it('discards a late read after switching documents and waits for another click', async () => {
    let settle!: (result: FileWorkspaceOpenResult) => void;
    const pending = new Promise<FileWorkspaceOpenResult>((resolve) => {
      settle = resolve;
    });
    const source = { openFile: () => pending };
    await render(source);
    await click();
    await render(source, false, 'other/guide.md');
    await act(async () => settle(await provider().openFile('images/plot.png')));
    expect(blobs.size).toBe(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Load image');
  });

  it('does not carry a load request into a different provider', async () => {
    await render(provider());
    await click();
    expect(blobs.size).toBe(1);
    await render({
      openFile: async () => {
        throw new Error('Must not read the new machine');
      },
    });
    expect(blobs.size).toBe(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Load image');
  });

  it('cannot grant filesystem access to an anonymous share', async () => {
    await act(async () =>
      root.render(
        <SessionReadonlyContext.Provider
          value={{ renderImage: () => null, renderFiles: () => null }}
        >
          <MarkdownFileResources
            provider={{
              openFile: async () => {
                throw new Error('Must not read');
              },
            }}
            documentPath="docs/a.md"
            automatic
            active
          >
            <MarkdownRenderer text="![Private image](../images/plot.png)" />
          </MarkdownFileResources>
        </SessionReadonlyContext.Provider>
      )
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('Private image');
  });
});

describe('Markdown session links', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const text = 'See [@Independent review](session://1ed6ba53-93bc-46d5-91e3-bb693cb0e729).';

  it('renders a session chip that opens the linked Session', async () => {
    const opened: string[] = [];
    await act(async () =>
      root.render(
        <SessionLinkProvider value={(target) => opened.push(target.sessionId)}>
          <MarkdownRenderer text={text} />
        </SessionLinkProvider>
      )
    );
    const chip = container.querySelector<HTMLButtonElement>('button[data-session-link]')!;
    expect(chip.textContent).toBe('Independent review');
    expect(container.querySelector('a')).toBeNull();
    await act(async () => chip.click());
    expect(opened).toEqual(['1ed6ba53-93bc-46d5-91e3-bb693cb0e729']);
  });

  it('stays an inert chip on a read-only share', async () => {
    await act(async () =>
      root.render(
        <SessionReadonlyContext.Provider
          value={{ renderImage: () => null, renderFiles: () => null }}
        >
          <SessionLinkProvider value={() => {}}>
            <MarkdownRenderer text={text} />
          </SessionLinkProvider>
        </SessionReadonlyContext.Provider>
      )
    );
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-session-link]')?.textContent).toBe('Independent review');
  });
});
