// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/* An absolute path with a `:line` suffix, of the shape agents emit when they
   cite a file they just touched. These used to vanish from the finished turn:
   the chip matched the turn's edited-files footer by basename and returned
   null, taking the link text with it. */
const MARKDOWN =
  '改动落在 [README.md](/srv/workspaces/demo-app/README.md:8)、' +
  '[conductor.json](/srv/workspaces/demo-app/conductor.json:3)、' +
  '[oss-revision.json](/srv/workspaces/demo-app/apps/cli-cloud/oss-revision.json:2) 三个文件。';

describe('agent file links in finished turns', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const writeText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => void root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  it('renders one clickable chip per cited file, keeping the surrounding prose intact', async () => {
    await act(async () => {
      root?.render(createElement(MarkdownRenderer, { text: MARKDOWN, isStreaming: false }));
    });

    const chips = [...(container?.querySelectorAll('button[title]') ?? [])].filter((el) =>
      el.getAttribute('title')?.startsWith('/srv/workspaces/demo-app/')
    );

    expect(chips.map((el) => el.getAttribute('title'))).toEqual([
      '/srv/workspaces/demo-app/README.md:8',
      '/srv/workspaces/demo-app/conductor.json:3',
      '/srv/workspaces/demo-app/apps/cli-cloud/oss-revision.json:2',
    ]);
    expect(chips.map((el) => el.textContent?.trim())).toEqual([
      'README.md',
      'conductor.json',
      'oss-revision.json',
    ]);

    // The enumeration commas must not be left dangling next to a hole.
    expect(container?.textContent).toContain(
      '改动落在 README.md、conductor.json、oss-revision.json 三个文件。'
    );
  });

  it('keeps opening on the file label and exposes a separate copy-path action', async () => {
    const onAgentFileLinkClick = vi.fn();
    await act(async () => {
      root?.render(
        createElement(MarkdownRenderer, {
          text: '[README.md](/srv/workspaces/demo-app/README.md:8)',
          isStreaming: false,
          onAgentFileLinkClick,
        })
      );
    });

    const openButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Open agent file: /srv/workspaces/demo-app/README.md"]'
    );
    const copyButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy agent file path: /srv/workspaces/demo-app/README.md"]'
    );

    expect(openButton).toBeTruthy();
    expect(copyButton).toBeTruthy();

    act(() => openButton?.click());
    expect(onAgentFileLinkClick).toHaveBeenCalledWith('/srv/workspaces/demo-app/README.md:8');

    await act(async () => copyButton?.click());
    expect(writeText).toHaveBeenCalledWith('/srv/workspaces/demo-app/README.md');
    expect(onAgentFileLinkClick).toHaveBeenCalledTimes(1);
    expect(copyButton?.getAttribute('aria-label')).toBe(
      'Copied: /srv/workspaces/demo-app/README.md'
    );
  });
});
