// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareSharePackage } from '@lody/shared/session-sharing';
import type { SessionHistory } from '@lody/shared';
import { SessionShareSurface } from '../src/components/sharing/session-share-page';
import { SessionSharePreview } from '../src/components/sharing/session-share-preview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../src/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
  nextCycledTheme: () => 'dark',
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
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy as Markdown"]'
    );
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(writeText.mock.calls[0]?.[0]).toContain('Frozen preview');
    expect(writeText.mock.calls[0]?.[0]).not.toContain('Changed source');
  });
  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    writeText.mockClear();
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
      sideSnapshot: { status: 'ready', history: [] },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = () => act(async () => root.render(<SessionShareSurface {...props} />));

  it('places opened conversations in a collapsible tree, child Tabs centrally and side chats at right', async () => {
    await render();
    const tree = container.querySelector('nav[aria-label="Conversation tree"]')!;
    expect(tree.textContent).toContain('Main');
    expect(tree.textContent).toContain('Review');
    expect(tree.textContent).not.toContain('Notes');
    expect(tree.textContent).not.toContain('Discussion');
    expect(container.querySelector('[data-conversation="c2"]')).not.toBeNull();
    expect(container.querySelector('aside [data-conversation="c4"]')).not.toBeNull();
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

  it('generates Markdown only when copied, using the displayed transcript and no source namespace', async () => {
    await render();
    expect(writeText).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Copy as Markdown"]')!.click()
    );
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
    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy as Markdown"]'
    )!;
    expect(copy.disabled).toBe(true);
    await act(async () => copy.click());
    expect(writeText).not.toHaveBeenCalled();
  });
});
