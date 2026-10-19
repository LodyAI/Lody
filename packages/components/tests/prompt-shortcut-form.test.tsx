// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { PromptShortcut } from '@lody/shared/prompt-shortcuts/model';
import { PromptShortcutForm } from '../src/components/settings/prompt-shortcut-form';
import { initI18n } from '../src/i18n';

const shortcut = (overrides: Partial<PromptShortcut> = {}): PromptShortcut => ({
  v: 1,
  id: 'shortcut-1',
  workspaceId: 'workspace-1',
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Review PR',
  slug: 'review-pr',
  prompt: 'Review the current diff.',
  mentions: [],
  scope: {},
  revision: 'rev-1',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const RULE_TEXT = 'Lowercase letters, numbers and dashes';

describe('PromptShortcutForm command field', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const renderForm = async (initial: PromptShortcut, isNew = false) => {
    await act(async () => {
      root?.render(
        <PromptShortcutForm
          initial={initial}
          options={{ projects: [], machines: [], providers: [] }}
          canShare={false}
          saving={false}
          isNew={isNew}
          onSave={vi.fn(async () => {})}
          onCancel={vi.fn()}
        />
      );
    });
  };

  const slugInput = () => {
    const input = document.body.querySelector<HTMLInputElement>('#shortcut-slug');
    if (!input) throw new Error('shortcut command field missing');
    return input;
  };

  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const warningVisible = () =>
    Array.from(document.body.querySelectorAll('div')).some((el) =>
      el.textContent?.includes(RULE_TEXT)
    );

  it('keeps a mid-token dash while typing a command', async () => {
    await renderForm(shortcut());
    const input = slugInput();
    for (const draft of ['a', 'a-', 'a-b']) {
      await type(input, draft);
    }
    expect(input.value).toBe('a-b');
    expect(warningVisible()).toBe(false);
  });

  it('warns over an invalid command without resetting the field', async () => {
    await renderForm(shortcut());
    const input = slugInput();
    await type(input, 'bad slug');
    expect(input.value).toBe('bad slug');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(warningVisible()).toBe(true);

    // Leaving the field neither clears the draft nor the warning.
    await act(async () => {
      input.dispatchEvent(new FocusEvent('blur'));
    });
    expect(input.value).toBe('bad slug');
    expect(warningVisible()).toBe(true);

    // A valid draft dismisses the warning on its own.
    await type(input, 'a-b');
    expect(warningVisible()).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('does not warn on an untouched new Shortcut still following the name', async () => {
    await renderForm(shortcut({ name: '', slug: '', prompt: '' }), true);
    const input = slugInput();
    expect(input.value).toBe('');
    expect(warningVisible()).toBe(false);

    const nameInput = document.body.querySelector<HTMLInputElement>('#shortcut-name');
    if (!nameInput) throw new Error('shortcut name field missing');
    await type(nameInput, 'My Command');
    expect(input.value).toBe('my-command');
    expect(warningVisible()).toBe(false);
  });
});
