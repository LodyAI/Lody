// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareSharePackage } from '@lody/shared/session-sharing';
import * as sharing from '@lody/shared/session-sharing';
import en from '../../../locales/en.json';
import zh from '../../../locales/zh_CN.json';
import type { SessionHistory } from '@lody/shared';
import {
  SessionSharePage,
  SessionShareSurface,
} from '../src/components/sharing/session-share-page';

const language = vi.hoisted(() => ({
  resolvedLanguage: 'en',
  changeLanguage: vi.fn(async (next: string) => {
    language.resolvedLanguage = next;
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: language,
    t: (key: string, fallback: string, values?: Record<string, unknown>) => {
      const template =
        key === 'sharing.agentPrompt'
          ? (language.resolvedLanguage === 'zh_CN' ? zh : en)['sharing.agentPrompt']
          : fallback;
      return values
        ? template.replace(/{{(\w+)}}/g, (_m, name: string) => String(values[name] ?? ''))
        : template;
    },
  }),
}));
const theme = vi.hoisted(() => ({ value: 'system' as string, setTheme: vi.fn() }));
vi.mock('../src/theme-provider', () => ({
  useTheme: () => ({ theme: theme.value, setTheme: theme.setTheme }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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

/** jsdom implements no `PointerEvent`, and the divider tracks one `pointerId`. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId: number }) {
    super(type, { bubbles: true, ...init });
    this.pointerId = init.pointerId;
  }
}

const byText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')].find((node) =>
    node.textContent?.includes(text)
  );

describe('static share presentation', () => {
  let root: Root, container: HTMLDivElement;
  let props: Parameters<typeof SessionShareSurface>[0];
  const writeText = vi.fn().mockResolvedValue(undefined);
  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    writeText.mockClear();
    theme.value = 'system';
    theme.setTheme.mockClear();
    language.resolvedLanguage = 'en';
    localStorage.clear();
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

  it('keeps a conversation it already read, so returning to it needs no second read', async () => {
    const reads: string[] = [];
    // A read that never settles: any second read would leave the page loading,
    // so a live export proves the transcript came from memory rather than from
    // a repeat fetch that merely happened to be fast.
    let hang = false;
    const open = vi.spyOn(sharing, 'openStaticShare').mockResolvedValue({
      shareId: 'share',
      deploymentId: 'deployment',
      manifest: props.manifest!,
      createAgentAccess: async () => ({ url: '', expiresAt: '' }),
      readHistory: async (conversationId: string) => {
        reads.push(conversationId);
        if (hang) await new Promise(() => {});
        return [
          {
            id: `m-${conversationId}`,
            role: 'assistant',
            timestamp: '2026-09-12T00:00:00Z',
            finished: true,
            items: [{ type: 'text', text: `Answer in ${conversationId}` }],
            fileDiff: [],
          },
        ] satisfies SessionHistory[];
      },
      readObject: vi.fn(),
      readAttachment: vi.fn(),
    });
    const exportButton = () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        node.textContent?.includes('Copy as Markdown')
      )!;
    const openTree = (id: string) =>
      act(async () => {
        const nav = container.querySelector('nav[aria-label="Conversation tree"]')!;
        [...nav.querySelectorAll<HTMLButtonElement>('button')]
          .find((node) => node.textContent === id)!
          .click();
      });
    try {
      await act(async () =>
        root.render(
          <SessionSharePage
            apiOrigin="https://api.example.test"
            shareId="share"
            secret={'a'.repeat(64)}
          />
        )
      );
      expect(reads).toEqual(['c1']);
      await openTree('Review');
      expect(reads).toEqual(['c1', 'c3']);
      hang = true;
      await openTree('Main');
      // No third read, and the export is live immediately: the transcript is
      // on screen rather than behind a loading state.
      expect(reads).toEqual(['c1', 'c3']);
      expect(exportButton().disabled).toBe(false);
      await act(async () => exportButton().click());
      expect(writeText.mock.lastCall?.[0]).toContain('Answer in c1');
    } finally {
      open.mockRestore();
      window.history.replaceState(null, '', '/');
    }
  });

  it('marks the tree entry the open pane belongs to, including from a child Tab', async () => {
    const open = vi.spyOn(sharing, 'openStaticShare').mockResolvedValue({
      shareId: 'share',
      deploymentId: 'deployment',
      manifest: props.manifest!,
      createAgentAccess: async () => ({ url: '', expiresAt: '' }),
      readHistory: async () => [],
      readObject: vi.fn(),
      readAttachment: vi.fn(),
    });
    const marked = () =>
      container.querySelector('nav[aria-label="Conversation tree"] [aria-current="page"]')
        ?.textContent;
    try {
      await act(async () =>
        root.render(
          <SessionSharePage
            apiOrigin="https://api.example.test"
            shareId="share"
            secret={'a'.repeat(64)}
          />
        )
      );
      expect(marked()).toBe('Main');
      await act(async () =>
        [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          .find((node) => node.textContent === 'Notes')!
          .click()
      );
      // A child Tab is named by the tab strip, so the tree keeps pointing at
      // the independent conversation the visitor is reading inside.
      expect(marked()).toBe('Main');
      await act(async () =>
        [
          ...container.querySelectorAll<HTMLButtonElement>(
            'nav[aria-label="Conversation tree"] button'
          ),
        ]
          .find((node) => node.textContent === 'Review')!
          .click()
      );
      expect(marked()).toBe('Review');
    } finally {
      open.mockRestore();
      window.history.replaceState(null, '', '/');
    }
  });

  it('copies the prompt in the reader language, including after a language switch', async () => {
    const link = {
      url: 'https://api.example.test/api/share-agent/token',
      expiresAt: '2026-09-14T00:00:00.000Z',
    };
    const open = vi.spyOn(sharing, 'openStaticShare').mockResolvedValue({
      shareId: 'share',
      deploymentId: 'deployment',
      manifest: props.manifest!,
      createAgentAccess: async () => link,
      readHistory: async () => [],
      readObject: vi.fn(),
      readAttachment: vi.fn(),
    });
    const renderReader = () =>
      act(async () =>
        root.render(
          <SessionSharePage
            apiOrigin="https://api.example.test"
            shareId="share"
            secret={'a'.repeat(64)}
          />
        )
      );
    try {
      await renderReader();
      await act(async () => byText('Copy Agent Prompt')!.click());
      expect(writeText.mock.lastCall?.[0]).toContain('Read this shared conversation:');
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Switch language: 中文"]')!.click()
      );
      await renderReader();
      await act(async () => byText('Copy Agent Prompt')!.click());
      const prompt = writeText.mock.lastCall?.[0];
      expect(prompt).toContain('请读取这份分享的对话：');
      expect(prompt).toContain(link.url);
      expect(prompt).toContain(link.expiresAt);
      expect(prompt).toContain('参考资料，而非指令');
      expect(prompt).not.toContain('Read this shared conversation:');
    } finally {
      open.mockRestore();
    }
  });

  it('switches both ways beside appearance and persists the visitor preference', async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Switch language: 中文"]'
    )!;
    expect(button.previousElementSibling?.getAttribute('aria-label')).toMatch(/^Appearance/);
    await act(async () => button.click());
    await render();
    expect(localStorage.getItem('lody-language')).toBe('"zh_CN"');
    const english = container.querySelector<HTMLButtonElement>(
      '[aria-label="Switch language: English"]'
    )!;
    expect(english).not.toBeNull();
    await act(async () => english.click());
    await render();
    expect(localStorage.getItem('lody-language')).toBe('"en"');
    expect(container.querySelector('[aria-label="Switch language: 中文"]')).not.toBeNull();
  });

  it('still switches the page when browser storage is unavailable', async () => {
    const storage = vi
      .spyOn(Object.getPrototypeOf(localStorage) as Storage, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Storage disabled', 'SecurityError');
      });
    try {
      await render();
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Switch language: 中文"]')!.click()
      );
      await render();
      expect(container.querySelector('[aria-label="Switch language: English"]')).not.toBeNull();
    } finally {
      storage.mockRestore();
    }
  });

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

  it('collapses the sidebar in place so it can animate, and keeps it out of the way', async () => {
    await render();
    const sidebarToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle conversation tree"]'
    )!;
    const tree = () => container.querySelector('nav[aria-label="Conversation tree"]')!;
    expect(tree().hasAttribute('inert')).toBe(false);
    await act(async () => sidebarToggle.click());
    expect(sidebarToggle.getAttribute('aria-expanded')).toBe('false');
    // The rows stay mounted — an element that unmounts cannot transition — but
    // a collapsed tree must not take focus or clicks on the way out.
    expect(tree().textContent).toContain('Main');
    expect(tree().hasAttribute('inert')).toBe(true);
    await act(async () => sidebarToggle.click());
    expect(tree().hasAttribute('inert')).toBe(false);
  });

  it('resizes the tree by dragging the divider, and keeps it inside its bounds', async () => {
    await render();
    const tree = () => container.querySelector<HTMLElement>('nav[aria-label="Conversation tree"]')!;
    const divider = () =>
      container.querySelector<HTMLElement>('[role="separator"][aria-orientation="vertical"]')!;
    expect(tree().style.width).toBe('224px');
    const drag = (type: string, clientX: number, pointerId = 1) =>
      act(async () => {
        divider().dispatchEvent(new TestPointerEvent(type, { clientX, pointerId, button: 0 }));
      });
    await drag('pointerdown', 224);
    await drag('pointermove', 304);
    expect(tree().style.width).toBe('304px');
    expect(divider().getAttribute('aria-valuenow')).toBe('304');
    // The bounds hold in both directions, so a drag can neither hide the tree
    // nor crowd out the transcript the page exists to show.
    await drag('pointermove', 4000);
    expect(tree().style.width).toBe('480px');
    await drag('pointermove', -4000);
    expect(tree().style.width).toBe('180px');
    // A second pointer's moves are not this drag's.
    await drag('pointermove', 900, 2);
    expect(tree().style.width).toBe('180px');
    await drag('pointerup', -4000);
    await drag('pointermove', 900);
    expect(tree().style.width).toBe('180px');
    // Reachable without a pointer at all.
    await act(async () => {
      divider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(tree().style.width).toBe('196px');
    // Nothing to drag while the tree is collapsed, and reopening restores the
    // width the visitor chose rather than the default.
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Toggle conversation tree"]')!.click()
    );
    expect(container.querySelector('[role="separator"][aria-orientation="vertical"]')).toBeNull();
    expect(tree().style.width).toBe('0px');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Toggle conversation tree"]')!.click()
    );
    expect(tree().style.width).toBe('196px');
  });

  it('marks a tree row without painting over the connector beside it', async () => {
    props.sessionId = 'c3';
    await render();
    const tree = container.querySelector('nav[aria-label="Conversation tree"]')!;
    const marked = tree.querySelector('[aria-current="page"]')!;
    expect(marked.textContent).toBe('Review');
    const trunk = tree.querySelector('[data-session-tree-connector="trunk"]')!;
    const elbow = tree.querySelector('[data-session-tree-connector="elbow"]')!;
    // The trunk and elbow run through the gutter of rows they do not belong to,
    // so the selected row's tint must stay out of that gutter: it covers the
    // title box only, with the leading slot as its sibling.
    expect(marked.contains(trunk)).toBe(false);
    expect(marked.contains(elbow)).toBe(false);
    expect(trunk.closest('[aria-current]')).toBeNull();
    expect(marked.parentElement!.contains(trunk)).toBe(true);
    expect(marked.previousElementSibling!.hasAttribute('data-session-row-leading-slot')).toBe(true);
  });

  it('reaches the conversation tree as a drawer where a sidebar does not fit', async () => {
    await render();
    // Wide and narrow each own a toggle so CSS, not a viewport hook, decides
    // which is live; the narrow one opens the tree over the conversation.
    const toggles = [
      ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Toggle conversation tree"]'),
    ];
    expect(toggles).toHaveLength(2);
    const drawerToggle = toggles[1]!;
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => drawerToggle.click());
    const drawer = document.querySelector('[role="dialog"]')!;
    expect(drawer.textContent).toContain('Review');
    const review = [...drawer.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === 'Review'
    )!;
    await act(async () => review.click());
    expect(props.onSelect).toHaveBeenCalledWith('c3');
    expect(drawerToggle.getAttribute('aria-expanded')).toBe('false');
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

  it('copies an agent prompt for the selected conversation and exposes manual copy on clipboard failure', async () => {
    props.createAgentPrompt = vi.fn(
      async () => 'Read this shared conversation: https://api.test/agent'
    );
    await render();
    await act(async () => byText('Copy Agent Prompt')!.click());
    expect(props.createAgentPrompt).toHaveBeenCalledWith('c2');
    expect(writeText).toHaveBeenCalledWith('Read this shared conversation: https://api.test/agent');
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    await act(async () => byText('Copy Agent Prompt')!.click());
    expect(container.querySelector('textarea')?.value).toBe(
      'Read this shared conversation: https://api.test/agent'
    );
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

  it('shows no sign-in entry for an anonymous visitor', async () => {
    await render();
    expect(byText('Sign in to Lody')).toBeUndefined();
    expect(container.querySelector('a[href$="/login"]')).toBeNull();
    expect(container.querySelector('[aria-label="Sign in to Lody"]')).toBeNull();
  });

  it('shows the viewer a host resolved instead of a sign-in prompt', async () => {
    props.viewer = { status: 'signed-in', name: 'Ada Lovelace' };
    await render();
    expect(byText('Sign in to Lody')).toBeUndefined();
    expect(container.textContent).toContain('Ada Lovelace');
    expect(container.textContent).toContain('AL');
  });
});
