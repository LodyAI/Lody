// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { WorktreeCheckboxPill } from '../src/components/shared/workdir-mode-selector';
import { initI18n } from '../src/i18n';

describe('WorktreeCheckboxPill', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it('shows Git loading progress instead of an inactive checkbox', () => {
    flushSync(() => {
      root?.render(<WorktreeCheckboxPill checked={false} loading />);
    });

    expect(container?.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(container?.querySelector('button[aria-label="Use worktree"]')).toBeNull();
    expect(container?.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('keeps the checkbox available after Git loading completes', () => {
    flushSync(() => {
      root?.render(<WorktreeCheckboxPill checked={false} />);
    });

    expect(container?.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(container?.querySelector('button[aria-label="Use worktree"]')).not.toBeNull();
  });
});
