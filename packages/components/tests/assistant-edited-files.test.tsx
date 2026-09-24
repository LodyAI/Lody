// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/icons/file-icons', () => ({
  FileIcon: () => createElement('span', { 'aria-hidden': true }),
}));

const { AssistantEditedFiles } = await import('../src/components/ai-gui/assistant-edited-files');
const { initI18n } = await import('../src/i18n');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('AssistantEditedFiles', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('labels changes without line counts while preserving ordinary diff stats', async () => {
    await act(async () => {
      root.render(
        createElement(AssistantEditedFiles, {
          files: [
            { filePath: 'README.md', add: 0, del: 0 },
            { filePath: 'src/app.ts', add: 4, del: 2 },
          ],
        })
      );
    });

    const uncountedRow = container.querySelector<HTMLElement>('[title="README.md"]');
    expect(uncountedRow?.textContent).toContain('Changed');
    expect(uncountedRow?.textContent).not.toContain('+0');
    expect(uncountedRow?.textContent).not.toContain('-0');

    const countedRow = container.querySelector<HTMLElement>('[title="src/app.ts"]');
    expect(countedRow?.textContent).toContain('+4');
    expect(countedRow?.textContent).toContain('-2');
  });

  it('labels an all-zero multi-file summary without line stats', async () => {
    await act(async () => {
      root.render(
        createElement(AssistantEditedFiles, {
          files: [
            { filePath: 'README.md', add: 0, del: 0 },
            { filePath: 'assets/image.png', add: 0, del: 0 },
          ],
        })
      );
    });

    expect(container.textContent).toContain('Changed');
    expect(container.textContent).not.toContain('+0');
    expect(container.textContent).not.toContain('-0');
  });
});
