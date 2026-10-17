// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MentionInput } from '../src/ui/mention/mention-input';
import { MentionItem } from '../src/ui/mention/mention-item';
import {
  MentionRoot,
  useMentionContext,
  type Mention as MentionRange,
} from '../src/ui/mention/mention-root';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Reads the menu's open state out of the mention context. */
function OpenProbe() {
  const context = useMentionContext('OpenProbe');
  return <div data-testid="open" data-open={context.open ? 'yes' : 'no'} />;
}

function Harness({ trigger }: { trigger: string }) {
  const [value, setValue] = React.useState('');
  const [mentions, setMentions] = React.useState<MentionRange[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  return (
    <MentionRoot
      triggers={[trigger]}
      trigger={trigger}
      inputValue={value}
      onInputValueChange={setValue}
      mentions={mentions}
      onMentionsChange={setMentions}
      value={selected}
      onValueChange={setSelected}
      onFilter={(options) => options}
      autoCloseOnEmpty={false}
    >
      <OpenProbe />
      <MentionInput value={value} onChange={() => {}} aria-label="composer" />
      <MentionItem value="alpha">Alpha</MentionItem>
    </MentionRoot>
  );
}

/** Types `text` into the textarea the way a real keystroke would. */
function typeInto(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )!.set!;
  setter.call(textarea, text);
  textarea.setSelectionRange(text.length, text.length);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Presses a key on the textarea the way a real keystroke would. */
function pressKey(textarea: HTMLTextAreaElement, key: string) {
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('MentionInput trigger detection', () => {
  let root: Root;
  let container: HTMLDivElement;
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function renderHarness(trigger: string) {
    act(() => {
      root = createRoot(container);
      root.render(<Harness trigger={trigger} />);
    });
    textarea = container.querySelector('textarea')!;
  }

  function isOpen() {
    return container.querySelector('[data-testid="open"]')?.getAttribute('data-open') === 'yes';
  }

  describe('`@` opens anywhere in the sentence', () => {
    beforeEach(() => renderHarness('@'));

    it('opens at the start of the input', () => {
      act(() => typeInto(textarea, '@'));
      expect(isOpen()).toBe(true);
    });

    it('opens after a space', () => {
      act(() => typeInto(textarea, 'hey @'));
      expect(isOpen()).toBe(true);
    });

    it('opens mid-sentence after CJK text', () => {
      act(() => typeInto(textarea, '我想@'));
      expect(isOpen()).toBe(true);
    });

    it('opens mid-sentence after an English word, with a query', () => {
      act(() => typeInto(textarea, 'fix this bug@alpha'));
      expect(isOpen()).toBe(true);
    });

    it('keeps the menu open for a still-ambiguous email prefix', () => {
      act(() => typeInto(textarea, 'user@example'));
      expect(isOpen()).toBe(true);
    });

    it('closes the menu once the query takes a domain shape', () => {
      act(() => typeInto(textarea, 'user@example'));
      expect(isOpen()).toBe(true);
      act(() => typeInto(textarea, 'user@example.com'));
      expect(isOpen()).toBe(false);
    });

    it('never opens for a domain query inside a CJK sentence', () => {
      act(() => typeInto(textarea, '我的邮箱是gabi@example.com'));
      expect(isOpen()).toBe(false);
    });

    it('never opens for a multi-label domain query', () => {
      act(() => typeInto(textarea, 'user@mail.example.com'));
      expect(isOpen()).toBe(false);
    });

    it('still opens for namespace and path queries', () => {
      act(() => typeInto(textarea, 'see @issue:123'));
      expect(isOpen()).toBe(true);
    });

    it('still opens for a standalone file mention with an extension', () => {
      act(() => typeInto(textarea, '@README.md'));
      expect(isOpen()).toBe(true);
    });

    it('still opens for a file mention with an extension after a space', () => {
      act(() => typeInto(textarea, 'open @package.json'));
      expect(isOpen()).toBe(true);
    });

    it('closes for a glued dotted query that reads as an address', () => {
      act(() => typeInto(textarea, 'fix bug@readme.md'));
      expect(isOpen()).toBe(false);
    });

    it('opens for a file name glued to CJK text', () => {
      act(() => typeInto(textarea, '请@README.md'));
      expect(isOpen()).toBe(true);
    });

    it('opens for a dotted role name glued to CJK text', () => {
      act(() => typeInto(textarea, '我想@GPT-5.6-Code-Reviewer'));
      expect(isOpen()).toBe(true);
    });

    it('opens for a dotted name whose last label is not a TLD', () => {
      act(() => typeInto(textarea, 'ask bug@GPT-5.6-Code-Reviewer'));
      expect(isOpen()).toBe(true);
    });

    it('opens for a mention typed after an address in the same sentence', () => {
      act(() => typeInto(textarea, '我的邮箱是gabi@example.com，请@README.md'));
      expect(isOpen()).toBe(true);
    });

    it('stays closed through every keystroke after the first dot of an address', () => {
      const address = 'gabi@example.com.cn';
      const firstDot = address.indexOf('.');
      act(() => typeInto(textarea, address.slice(0, firstDot)));
      expect(isOpen()).toBe(true);
      for (let end = firstDot + 1; end <= address.length; end += 1) {
        act(() => typeInto(textarea, address.slice(0, end)));
        expect(isOpen(), address.slice(0, end)).toBe(false);
      }
    });

    it('keeps a dotted name open at every keystroke when CJK precedes the trigger', () => {
      const text = '我想@GPT-5.6-Code-Reviewer';
      for (let end = '我想@'.length; end <= text.length; end += 1) {
        act(() => typeInto(textarea, text.slice(0, end)));
        expect(isOpen(), text.slice(0, end)).toBe(true);
      }
    });

    it('Enter after the menu gave up on a domain query leaves the text alone', () => {
      act(() => typeInto(textarea, 'user@example'));
      expect(isOpen()).toBe(true);
      act(() => pressKey(textarea, 'Escape'));
      act(() => typeInto(textarea, 'user@example.com'));
      expect(isOpen()).toBe(false);
      act(() => pressKey(textarea, 'Enter'));
      expect(textarea.value).toBe('user@example.com');
    });
  });

  describe('Escape keeps the menu closed for that trigger', () => {
    beforeEach(() => renderHarness('@'));

    it('stays closed while the user types on after the dismissed trigger', () => {
      act(() => typeInto(textarea, 'user@gm'));
      expect(isOpen()).toBe(true);
      act(() => pressKey(textarea, 'Escape'));
      expect(isOpen()).toBe(false);
      act(() => typeInto(textarea, 'user@gmail'));
      expect(isOpen()).toBe(false);
    });

    it('stays closed when text is inserted before the dismissed trigger', () => {
      act(() => typeInto(textarea, 'a@x'));
      act(() => pressKey(textarea, 'Escape'));
      act(() => typeInto(textarea, 'za@x'));
      expect(isOpen()).toBe(false);
    });

    it('opens again for a new trigger typed after the dismissed one', () => {
      act(() => typeInto(textarea, 'a@x'));
      act(() => pressKey(textarea, 'Escape'));
      act(() => typeInto(textarea, 'a@x @'));
      expect(isOpen()).toBe(true);
    });

    it('opens again once the dismissed trigger is deleted and retyped', () => {
      act(() => typeInto(textarea, 'user@gm'));
      act(() => pressKey(textarea, 'Escape'));
      act(() => typeInto(textarea, 'user'));
      act(() => typeInto(textarea, 'user@'));
      expect(isOpen()).toBe(true);
    });

    it('opens again after the input is cleared', () => {
      act(() => typeInto(textarea, '@x'));
      act(() => pressKey(textarea, 'Escape'));
      act(() => typeInto(textarea, ''));
      act(() => typeInto(textarea, '@'));
      expect(isOpen()).toBe(true);
    });
  });

  describe('`$` keeps its word guard', () => {
    beforeEach(() => renderHarness('$'));

    it('opens at the start of the input', () => {
      act(() => typeInto(textarea, '$'));
      expect(isOpen()).toBe(true);
    });

    it('stays closed inside a word so code stays plain text', () => {
      act(() => typeInto(textarea, 'price$'));
      expect(isOpen()).toBe(false);
    });
  });
});
