// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Mention, MentionInput, MentionItem, useMentionContext } from '../src/ui/mention';
import type { ItemData, Mention as MentionRange } from '../src/ui/mention/mention-root';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ItemSpec = {
  value: string;
  label?: string;
  insertText?: string;
  navigateText?: string;
  onMentionNavigate?: () => void;
  kind?: ItemData['kind'];
};

const latest: {
  inputValue: string;
  mentions: readonly MentionRange[];
  values: readonly string[];
  open: boolean;
  onMentionAdd:
    | ((value: string, triggerIndex: number, options?: { commit?: boolean }) => void)
    | null;
} = { inputValue: '', mentions: [], values: [], open: false, onMentionAdd: null };

function Probe() {
  const context = useMentionContext('Probe');
  latest.inputValue = context.inputValue;
  latest.mentions = context.mentions;
  latest.values = context.value;
  latest.open = context.open;
  latest.onMentionAdd = context.onMentionAdd;
  return null;
}

function Harness({
  items,
  initialValue,
  withChips = false,
  isReadonly = false,
}: {
  items: ItemSpec[];
  initialValue: string;
  withChips?: boolean;
  isReadonly?: boolean;
}) {
  const [value, setValue] = React.useState(initialValue);
  const [mentions, setMentions] = React.useState<MentionRange[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);

  return (
    <Mention
      defaultOpen
      inputValue={value}
      onInputValueChange={setValue}
      mentions={mentions}
      onMentionsChange={setMentions}
      value={selected}
      onValueChange={setSelected}
      getMentionChip={withChips ? () => ({}) : undefined}
      onFilter={(options) => options}
      autoCloseOnEmpty={false}
      readonly={isReadonly}
    >
      <Probe />
      <MentionInput value={value} onChange={() => {}} />
      {items.map((item) => (
        <MentionItem
          key={item.value}
          value={item.value}
          label={item.label ?? item.value}
          insertText={item.insertText}
          navigateText={item.navigateText}
          onMentionNavigate={item.onMentionNavigate}
          kind={item.kind}
        >
          {item.value}
        </MentionItem>
      ))}
    </Mention>
  );
}

describe('Mention navigation and insertion', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;

  beforeEach(() => {
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback) => {
      callback(0);
      return 0;
    }) as typeof requestAnimationFrame;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest.onMentionAdd = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      delete (
        globalThis as typeof globalThis & { requestAnimationFrame?: typeof requestAnimationFrame }
      ).requestAnimationFrame;
    }
    originalRequestAnimationFrame = undefined;
  });

  function render(
    items: ItemSpec[],
    initialValue: string,
    caret = initialValue.length,
    withChips = false,
    isReadonly = false
  ) {
    act(() => {
      root?.render(
        <Harness
          items={items}
          initialValue={initialValue}
          withChips={withChips}
          isReadonly={isReadonly}
        />
      );
    });
    const input = container?.querySelector('textarea');
    if (!input) throw new Error('Expected mention textarea to render');
    act(() => {
      input.setSelectionRange(caret, caret);
      input.focus();
    });
    return input;
  }

  function commit(value: string, triggerIndex: number, options?: { commit?: boolean }) {
    act(() => {
      latest.onMentionAdd?.(value, triggerIndex, options);
    });
  }

  function pressKey(input: HTMLTextAreaElement, key: string, init?: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      input.dispatchEvent(event);
    });
    return event;
  }

  function setNativeValue(input: HTMLTextAreaElement, value: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setValue?.call(input, value);
  }

  it('writes the item insertText instead of composing trigger and label', () => {
    render([{ value: '3312', label: '3312', insertText: '#3312', kind: 'issue' }], '@');

    commit('3312', 0);

    expect(latest.inputValue).toBe('#3312 ');
    expect(latest.mentions).toEqual([{ value: '3312', start: 0, end: 5, kind: 'issue' }]);
    expect(latest.values).toEqual(['3312']);
  });

  it('falls back to trigger and label when the item has no insertText', () => {
    render([{ value: 'src/app.ts' }], '@');

    commit('src/app.ts', 0);

    expect(latest.inputValue).toBe('@src/app.ts ');
    expect(latest.mentions).toEqual([{ value: 'src/app.ts', start: 0, end: 11, kind: 'mention' }]);
  });

  it('records no mention when selecting a navigation item', () => {
    render([{ value: 'issue', label: 'Issues', navigateText: '@issue:' }], '@');

    commit('issue', 0);

    // Rewrites the trigger span, no trailing space, menu stays up for level two.
    expect(latest.inputValue).toBe('@issue:');
    expect(latest.mentions).toEqual([]);
    expect(latest.values).toEqual([]);
    expect(latest.open).toBe(true);
  });

  it('starts destination work synchronously when selecting a navigation item', () => {
    let navigations = 0;
    render(
      [
        {
          value: 'skill',
          label: 'Skills',
          navigateText: '@skill:',
          onMentionNavigate: () => {
            navigations += 1;
          },
        },
      ],
      '@'
    );

    commit('skill', 0);

    expect(navigations).toBe(1);
    expect(latest.inputValue).toBe('@skill:');
  });

  it('does not start destination work when a navigation item is force-committed', () => {
    let navigations = 0;
    render(
      [
        {
          value: 'src/',
          navigateText: '@src/',
          insertText: '@src',
          onMentionNavigate: () => {
            navigations += 1;
          },
        },
      ],
      '@src/'
    );

    commit('src/', 0, { commit: true });

    expect(navigations).toBe(0);
    expect(latest.inputValue).toBe('@src ');
  });

  it('commits a navigation item through insertText when commit is requested', () => {
    render([{ value: 'src/', navigateText: '@src/', insertText: '@src', kind: 'dir' }], '@src/');

    commit('src/', 0, { commit: true });

    expect(latest.inputValue).toBe('@src ');
    expect(latest.mentions).toEqual([{ value: 'src/', start: 0, end: 4, kind: 'dir' }]);
  });

  it('pops a category prefix back to the bare trigger on Backspace', () => {
    const input = render([{ value: 'issue', navigateText: '@issue:' }], '@issue:');

    const event = pressKey(input, 'Backspace');

    expect(event.defaultPrevented).toBe(true);
    expect(latest.inputValue).toBe('@');
  });

  it('pops a category prefix back to the bare trigger on ArrowLeft', () => {
    const input = render([{ value: 'issue', navigateText: '@issue:' }], '@issue:');

    const event = pressKey(input, 'ArrowLeft');

    expect(event.defaultPrevented).toBe(true);
    expect(latest.inputValue).toBe('@');
  });

  it('leaves Backspace alone inside a path drill-down', () => {
    // `@src/` is a path, not a `<namespace>:` prefix: Backspace must keep
    // deleting one character so the user can walk back up a level at a time.
    const input = render([{ value: 'src/', navigateText: '@src/' }], '@src/');

    const event = pressKey(input, 'Backspace');

    expect(event.defaultPrevented).toBe(false);
    expect(latest.inputValue).toBe('@src/');
  });

  it('descends into the highlighted navigation item on Tab', () => {
    const input = render([{ value: 'issue', label: 'Issues', navigateText: '@issue:' }], '@');

    const event = pressKey(input, 'Tab');

    expect(event.defaultPrevented).toBe(true);
    expect(latest.inputValue).toBe('@issue:');
    expect(latest.mentions).toEqual([]);
  });

  it('commits the highlighted non-navigation item on Tab', () => {
    const input = render([{ value: '3312', insertText: '#3312', kind: 'issue' }], '@');

    const event = pressKey(input, 'Tab');

    expect(event.defaultPrevented).toBe(true);
    expect(latest.inputValue).toBe('#3312 ');
    expect(latest.mentions).toEqual([{ value: '3312', start: 0, end: 5, kind: 'issue' }]);
  });

  it('leaves Shift+Tab alone so it does not commit the highlighted item', () => {
    const input = render([{ value: '3312', insertText: '#3312', kind: 'issue' }], '@');

    const event = pressKey(input, 'Tab', { shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(latest.inputValue).toBe('@');
    expect(latest.mentions).toEqual([]);
  });

  it('snaps a caret inside a session mention to a boundary before editing', () => {
    const input = render([{ value: 'sess_1', insertText: '@fix-ci', kind: 'session' }], '@');
    commit('sess_1', 0);

    act(() => {
      input.setSelectionRange(3, 3);
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(input.selectionStart).toBe(0);

    act(() => {
      setNativeValue(input, `X${input.value}`);
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(latest.inputValue).toBe('X@fix-ci ');
    expect(latest.mentions).toEqual([{ value: 'sess_1', start: 1, end: 8, kind: 'session' }]);
  });

  it('keeps mention mirrors aligned while an IME composes before a session mention', () => {
    const input = render(
      [{ value: 'sess_1', insertText: '@fix-ci', kind: 'session' }],
      '@',
      1,
      true
    );
    commit('sess_1', 0);

    act(() => {
      input.setSelectionRange(0, 0);
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      setNativeValue(input, 'zhong@fix-ci ');
      input.setSelectionRange(5, 5);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(input.selectionStart).toBe(5);
    expect(container?.querySelector('[data-mention-layer="background"]')?.textContent).toContain(
      'zhong@fix-ci'
    );
    expect(container?.querySelector('[data-mention-layer="chip"]')).not.toBeNull();
    expect(
      container
        ?.querySelector('[data-mention-layer="chip"] [data-mention-kind="session"]')
        ?.getAttribute('data-mention-start')
    ).toBe('5');

    act(() => {
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(input.selectionStart).toBe(5);

    act(() => {
      setNativeValue(input, '中@fix-ci ');
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    });

    expect(latest.inputValue).toBe('中@fix-ci ');
    expect(latest.mentions).toEqual([{ value: 'sess_1', start: 1, end: 8, kind: 'session' }]);
    expect(container?.querySelector('[data-mention-layer="chip"]')).not.toBeNull();
  });

  it('keeps the native caret above a chip at both edges', () => {
    const input = render([{ value: 'plan', insertText: '/plan', kind: 'command' }], '/', 1, true);
    commit('plan', 0);

    act(() => {
      input.setSelectionRange(5, 5);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(container?.querySelector('[data-mention-caret]')).toBeNull();
    expect(input.className).toContain('z-30');
    expect(input.style.getPropertyValue('-webkit-text-fill-color')).toBe('transparent');

    act(() => {
      input.setSelectionRange(0, 0);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(container?.querySelector('[data-mention-caret]')).toBeNull();
    expect(input.className).toContain('z-30');
    expect(input.style.getPropertyValue('-webkit-text-fill-color')).toBe('transparent');

    act(() => {
      input.setSelectionRange(6, 6);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(input.className).toContain('z-10');
    expect(input.className).not.toContain('z-30');
    expect(input.style.getPropertyValue('-webkit-text-fill-color')).toBe('');
  });

  it('keeps a readonly caret out of the opaque chip interior', () => {
    const items = [{ value: 'plan', insertText: '/plan', kind: 'command' }];
    const input = render(items, '/', 1, true, true);
    commit('plan', 0);

    act(() => {
      input.setSelectionRange(2, 2);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Home', bubbles: true }));
    });

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(0);
  });
});
