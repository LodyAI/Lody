// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareSharePackage } from '@lody/shared/session-sharing';
import type { SessionHistory } from '@lody/shared';
import { SessionShareSurface } from '../src/components/sharing/session-share-page';
import { SessionSharePreview } from '../src/components/sharing/session-share-preview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, values?: Record<string, unknown>) =>
      values
        ? fallback.replace(/{{(\w+)}}/g, (_m, name: string) => String(values[name] ?? ''))
        : fallback,
  }),
}));
const theme = vi.hoisted(() => ({ value: 'system' as string, setTheme: vi.fn() }));
vi.mock('../src/theme-provider', () => ({
  useTheme: () => ({ theme: theme.value, setTheme: theme.setTheme }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Exercise the real share shell and copy builder without a virtualized viewport.
vi.mock('../src/components/ai-gui/view', () => ({
  SessionChatStreamView: ({ sessionId }: { sessionId: string }) => (
    <div data-conversation={sessionId} />
  ),
  MessageRowView: () => null,
}));
vi.mock('../src/components/sharing/share-attachments', () => ({
  SharedImage: () => null,
  SharedFile: () => null,
  SharedAttachmentUnavailable: () => null,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const byText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')].find((node) =>
    node.textContent?.includes(text)
  );

describe('static share presentation', () => {
  let root: Root, container: HTMLDivElement;
  let props: Parameters<typeof SessionShareSurface>[0];
  const writeText = vi.fn().mockResolvedValue(undefined);
  it('previews and copies the frozen unpublished bytes, not later source edits', async () => {
    const source = [
      { id: 'turn', role: 'assistant', items: [{ type: 'text', text: 'Frozen preview' }] },
    ];
    const prepared = await prepareSharePackage({
      rootSourceId: 'root',
      capturedAt: '2026-09-12T00:00:00.000Z',
      conversations: [{ sourceId: 'root', title: 'Preview', history: source }],
      readAttachment: async () => {
        throw new Error('Unexpected source read');
      },
    });
    source[0]!.items[0]!.text = 'Changed source';
    await act(async () => root.render(<SessionSharePreview prepared={prepared} />));
    const button = byText('Copy as Markdown') as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(writeText.mock.calls[0]?.[0]).toContain('Frozen preview');
    expect(writeText.mock.calls[0]?.[0]).not.toContain('Changed source');
  });

  it('keeps visitor chrome out of the publisher’s embedded preview', async () => {
    const prepared = await prepareSharePackage({
      rootSourceId: 'root',
      capturedAt: '2026-09-12T00:00:00.000Z',
      conversations: [{ sourceId: 'root', title: 'Preview', history: [] }],
      readAttachment: async () => {
        throw new Error('Unexpected source read');
      },
    });
    await act(async () => root.render(<SessionSharePreview prepared={prepared} />));
    // The app owns its own appearance: an embedded preview must not offer a
    // theme control that would repaint the surrounding app, nor force one.
    expect(byText('Sign in to Lody')).toBeUndefined();
    expect(container.querySelector('[aria-label^="Appearance"]')).toBeNull();
    expect(theme.setTheme).not.toHaveBeenCalled();
  });

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    writeText.mockClear();
    theme.value = 'system';
    theme.setTheme.mockClear();
    const { manifest } = await prepareSharePackage({
      rootSourceId: 'root',
      capturedAt: '2026-09-12T00:00:00.000Z',
      conversations: [
        { sourceId: 'root', title: 'Main', history: [] },
        { sourceId: 'tab', title: 'Notes', parentSourceId: 'root', history: [] },
        { sourceId: 'opened', title: 'Review', openedBySourceId: 'tab', history: [] },
        {
          sourceId: 'side',
          title: 'Discussion',
          parentSourceId: 'root',
          childSessionPlacement: 'side-panel',
          history: [],
        },
      ],
      readAttachment: async () => {
        throw new Error('Unexpected attachment');
      },
    });
    props = {
      manifest,
      sessionId: 'c2',
      status: 'ready',
      onSelect: vi.fn(),
      attachmentAccess: { read: vi.fn() },
      snapshot: {
        status: 'ready',
        history: [
          {
            id: 'm',
            role: 'assistant',
            timestamp: '2026-09-12T00:00:00Z',
            finished: true,
            items: [{ type: 'text', text: 'Frozen answer' }],
            fileDiff: [],
          },
        ] satisfies SessionHistory[],
      },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = () => act(async () => root.render(<SessionShareSurface {...props} />));

  it('places opened conversations in a collapsible tree and every child in the one pane', async () => {
    await render();
    const tree = container.querySelector('nav[aria-label="Conversation tree"]')!;
    expect(tree.textContent).toContain('Main');
    expect(tree.textContent).toContain('Review');
    expect(tree.textContent).not.toContain('Notes');
    expect(tree.textContent).not.toContain('Discussion');
    expect(container.querySelector('[data-conversation="c2"]')).not.toBeNull();
    // No right pane, and no toggle for one.
    expect(container.querySelector('aside')).toBeNull();
    expect(container.querySelector('[aria-label="Toggle side conversation"]')).toBeNull();
    await act(async () =>
      tree.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!.click()
    );
    expect(tree.textContent).not.toContain('Review');
    await act(async () =>
      tree.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click()
    );
    const review = [...tree.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Review'
    )!;
    await act(async () => review.click());
    expect(props.onSelect).toHaveBeenCalledWith('c3');
  });

  it('names each pane with the app’s tab, so child Tabs and a solo conversation match', async () => {
    await render();
    const tabs = container.querySelector('[role="tablist"]')!;
    const labels = [...tabs.querySelectorAll('[role="tab"]')].map((node) => node.textContent);
    // A side-panel child stays reachable as a Tab rather than disappearing.
    expect(labels).toEqual(['Main', 'Notes', 'Discussion']);
    expect(tabs.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Notes');
    await act(async () =>
      [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((node) => node.textContent === 'Discussion')!
        .click()
    );
    expect(props.onSelect).toHaveBeenCalledWith('c4');
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });

  it('generates Markdown only when copied, using the displayed transcript and no source namespace', async () => {
    await render();
    expect(writeText).not.toHaveBeenCalled();
    const copy = container.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
    const main = [...copy].find((node) => node.textContent?.includes('Copy as Markdown'))!;
    await act(async () => main.click());
    expect(writeText).toHaveBeenCalledOnce();
    const markdown = writeText.mock.calls[0]![0] as string;
    expect(markdown).toContain('Notes');
    expect(markdown).toContain('Frozen answer');
    expect(markdown).not.toContain('workspace');
    expect(props.attachmentAccess.read).not.toHaveBeenCalled();
  });

  it('does not offer export before the selected transcript has loaded', async () => {
    props.snapshot = { status: 'loading', history: [] };
    await render();
    const copy = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes('Copy as Markdown')
    )!;
    expect(copy.disabled).toBe(true);
    await act(async () => copy.click());
    expect(writeText).not.toHaveBeenCalled();
  });

  it('offers Fork as a disabled, explicitly unfinished action', async () => {
    await render();
    const fork = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes('Fork to my Lody workspace')
    )!;
    expect(fork.disabled).toBe(true);
    expect(fork.getAttribute('aria-label')).toContain('coming soon');
  });

  it('starts Light and switches only between Light and Dark', async () => {
    await render();
    expect(theme.setTheme).toHaveBeenCalledWith('light');
    theme.setTheme.mockClear();
    theme.value = 'light';
    await render();
    expect(theme.setTheme).not.toHaveBeenCalled();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label^="Appearance"]')!;
    await act(async () => toggle.click());
    expect(theme.setTheme).toHaveBeenCalledWith('dark');
    theme.value = 'dark';
    theme.setTheme.mockClear();
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Appearance"]')!.click()
    );
    expect(theme.setTheme).toHaveBeenCalledExactlyOnceWith('light');
  });

  it('leads the header with a Lody mark that goes back to the product', async () => {
    await render();
    const brand = [...container.querySelectorAll('header a')].find((node) =>
      node.textContent?.includes('Lody')
    ) as HTMLAnchorElement;
    expect(brand.target).toBe('_blank');
    expect(brand.rel).toContain('noopener');
    expect(brand.getAttribute('href')).not.toContain('/login');
    expect(brand.querySelector('img')).not.toBeNull();
  });

  it('sends an anonymous visitor to the app to sign in, in a new tab', async () => {
    await render();
    const signIn = byText('Sign in to Lody') as HTMLAnchorElement;
    expect(signIn.tagName).toBe('A');
    expect(signIn.target).toBe('_blank');
    expect(signIn.rel).toContain('noopener');
    expect(signIn.getAttribute('href')?.endsWith('/login')).toBe(true);
  });

  it('shows the viewer a host resolved instead of a sign-in prompt', async () => {
    props.viewer = { status: 'signed-in', name: 'Ada Lovelace' };
    await render();
    expect(byText('Sign in to Lody')).toBeUndefined();
    expect(container.textContent).toContain('Ada Lovelace');
    expect(container.textContent).toContain('AL');
  });
});
