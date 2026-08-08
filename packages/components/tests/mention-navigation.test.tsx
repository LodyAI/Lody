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

function Harness({ items, initialValue }: { items: ItemSpec[]; initialValue: string }) {
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
      onFilter={(options) => options}
      autoCloseOnEmpty={false}
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

  function render(items: ItemSpec[], initialValue: string, caret = initialValue.length) {
    act(() => {
      root?.render(<Harness items={items} initialValue={initialValue} />);
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

  function pressKey(input: HTMLTextAreaElement, key: string) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(event);
    });
    return event;
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

  it('leaves Tab alone when the highlighted item is not a navigation item', () => {
    // Tab must stay a plain focus move here: it neither descends nor inserts.
    // (Whether the menu reopens afterwards is decided by trigger re-detection,
    // which this contract does not cover.)
    const input = render([{ value: '3312', insertText: '#3312' }], '@');

    const event = pressKey(input, 'Tab');

    expect(event.defaultPrevented).toBe(false);
    expect(latest.inputValue).toBe('@');
    expect(latest.mentions).toEqual([]);
  });
});
