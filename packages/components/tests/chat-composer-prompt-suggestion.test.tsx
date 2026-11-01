// @vitest-environment jsdom

import { act, createElement, createRef, useState, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));

vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

const layout = vi.hoisted(() => ({ mobile: false }));
vi.mock('../src/hooks/use-mobile', () => ({ useIsMobile: () => layout.mobile }));

import { ChatComposer } from '../src/components/chat/chat-composer';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SUGGESTION = 'Summarize the failing test and propose the smallest fix.';

let setPromptValue: ((value: string) => void) | null = null;

function Harness({
  promptRef,
  suggestion = SUGGESTION,
  initialPrompt = '',
  disabled = false,
  preservePromptFocus = false,
  variant = 'session',
  onPromptChange,
}: {
  promptRef: RefObject<HTMLTextAreaElement | null>;
  suggestion?: string | null;
  initialPrompt?: string;
  disabled?: boolean;
  preservePromptFocus?: boolean;
  variant?: 'session' | 'sheet';
  onPromptChange?: (value: string) => void;
}) {
  const [promptValue, setPromptValueState] = useState(initialPrompt);
  setPromptValue = setPromptValueState;
  return createElement(ChatComposer, {
    variant,
    preservePromptFocus,
    promptRef,
    promptValue,
    onPromptChange: (value) => {
      onPromptChange?.(value);
      setPromptValueState(value);
    },
    promptSuggestion: suggestion,
    promptDisabled: disabled,
    focusOnContainerClick: true,
    primaryAction: null,
  });
}

function getSuggestionHint(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-prompt-suggestion]');
}

async function pressTab(
  textarea: HTMLTextAreaElement,
  init: KeyboardEventInit = {}
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    textarea.dispatchEvent(event);
  });
  return event;
}

describe('ChatComposer prompt suggestion', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    layout.mobile = false;
    setPromptValue = null;
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows the desktop Tab hint only while the draft is empty, and restores it after clearing', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    await act(async () => {
      root.render(createElement(Harness, { promptRef }));
    });

    const hint = getSuggestionHint(container);
    expect(hint).not.toBeNull();
    expect(hint?.querySelector('kbd')?.textContent).toBe('Tab');
    expect(hint?.textContent).toContain(SUGGESTION);
    expect(hint?.querySelector('button')).toBeNull();

    await act(async () => setPromptValue?.('A draft the user typed'));
    expect(getSuggestionHint(container)).toBeNull();

    await act(async () => setPromptValue?.(''));
    expect(getSuggestionHint(container)?.textContent).toContain(SUGGESTION);
  });

  it('hides the hint during IME composition before the draft value commits', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    const changes: string[] = [];
    await act(async () => {
      root.render(
        createElement(Harness, { promptRef, onPromptChange: (value) => changes.push(value) })
      );
    });
    const textarea = promptRef.current!;
    expect(getSuggestionHint(container)).not.toBeNull();

    // The mention input holds preedit text locally and commits only at
    // compositionend, so the owner's value is still empty here.
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      textarea.value = 'ni';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(changes).toEqual([]);
    expect(getSuggestionHint(container)).toBeNull();

    // A cancelled composition leaves the draft empty, so the hint returns.
    await act(async () => {
      textarea.value = '';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    expect(getSuggestionHint(container)?.textContent).toContain(SUGGESTION);

    // A committed composition becomes the draft and keeps the hint hidden.
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      textarea.value = '你好';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    expect(changes.at(-1)).toBe('你好');
    expect(getSuggestionHint(container)).toBeNull();
  });

  it('accepts with Tab as an editable draft, places the caret at the end, and does not consume the suggestion', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    const onChange = vi.fn();
    await act(async () => {
      root.render(createElement(Harness, { promptRef, onPromptChange: onChange }));
    });

    const textarea = promptRef.current!;
    textarea.focus();
    await pressTab(textarea);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(SUGGESTION);
    expect(textarea.value).toBe(SUGGESTION);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(SUGGESTION.length);
    expect(textarea.selectionEnd).toBe(SUGGESTION.length);
    expect(getSuggestionHint(container)).toBeNull();

    // The source suggestion is advisory, not consumed: an empty draft shows the
    // same hint again.
    await act(async () => setPromptValue?.(''));
    const hint = getSuggestionHint(container);
    expect(hint?.textContent).toContain(SUGGESTION);
    expect(hint?.querySelector('kbd')?.textContent).toBe('Tab');
  });

  it('leaves Tab to the draft, modified keys, IME composition, and disabled composers', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        createElement(Harness, {
          promptRef,
          initialPrompt: 'Keep this text',
          onPromptChange: onChange,
        })
      );
    });
    expect(getSuggestionHint(container)).toBeNull();
    await pressTab(promptRef.current!);
    expect(onChange).not.toHaveBeenCalled();
    expect(promptRef.current?.value).toBe('Keep this text');

    await act(async () => setPromptValue?.(''));
    await pressTab(promptRef.current!, { shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(promptRef.current?.value).toBe('');

    await pressTab(promptRef.current!, { isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(promptRef.current?.value).toBe('');

    await act(async () => {
      root.render(
        createElement(Harness, {
          promptRef,
          disabled: true,
          preservePromptFocus: true,
          onPromptChange: onChange,
        })
      );
    });
    expect(getSuggestionHint(container)).toBeNull();
    expect(promptRef.current?.disabled).toBe(false);
    expect(promptRef.current?.getAttribute('aria-disabled')).toBe('true');
    await pressTab(promptRef.current!);
    expect(onChange).not.toHaveBeenCalled();
    expect(promptRef.current?.value).toBe('');
  });

  it.each(['session', 'sheet'] as const)(
    'shows Apply on mobile %s, accepts only from that control, and focuses the input from the hint text',
    async (variant) => {
      layout.mobile = true;
      const promptRef = createRef<HTMLTextAreaElement>();
      const onChange = vi.fn();
      await act(async () => {
        root.render(createElement(Harness, { promptRef, variant, onPromptChange: onChange }));
      });

      const hint = getSuggestionHint(container)!;
      const apply = hint.querySelector('button');
      expect(apply?.textContent).toBe('Apply');
      expect(hint.querySelector('kbd')).toBeNull();

      await pressTab(promptRef.current!);
      expect(onChange).not.toHaveBeenCalled();
      expect(promptRef.current?.value).toBe('');

      const suggestionText = hint.querySelector('span:last-child')!;
      await act(async () => suggestionText.click());
      expect(onChange).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(promptRef.current);
      expect(promptRef.current?.value).toBe('');

      await act(async () => apply!.click());
      expect(onChange).toHaveBeenCalledWith(SUGGESTION);
      expect(promptRef.current?.value).toBe(SUGGESTION);
      expect(document.activeElement).toBe(promptRef.current);
      expect(promptRef.current?.selectionStart).toBe(SUGGESTION.length);
    }
  );

  it('ignores empty and whitespace-only suggestions', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    await act(async () => {
      root.render(createElement(Harness, { promptRef, suggestion: '   ' }));
    });
    expect(getSuggestionHint(container)).toBeNull();
    await pressTab(promptRef.current!);
    expect(promptRef.current?.value).toBe('');

    await act(async () => {
      root.render(createElement(Harness, { promptRef, suggestion: '' }));
    });
    expect(getSuggestionHint(container)).toBeNull();
  });
});
