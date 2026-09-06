// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mention, useMentionContext } from '../src/ui/mention';
import type { Mention as MentionRange } from '../src/ui/mention/index';
import { UrlReferenceInput } from '../src/components/mentions/url-reference-input';

let ranges: MentionRange[] = [];
function Probe() {
  ranges = useMentionContext('Probe').mentions;
  return null;
}
function Harness() {
  const [value, setValue] = React.useState('😀 ');
  return (
    <Mention inputValue={value} onInputValueChange={setValue} triggers={[]}>
      <Probe />
      <UrlReferenceInput value={value} />
    </Mention>
  );
}
describe('native URL paste', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  function input(value: string, inputType: string) {
    const textarea = host.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        value
      );
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
    });
    return textarea.value;
  }
  it('adds metadata after native paste and restores decoration after undo/redo', () => {
    const text = '😀 https://example.test/a?q=1#section';
    expect(input(text, 'insertFromPaste')).toBe(text);
    expect(ranges).toEqual([{ start: 3, end: text.length, value: text.slice(3), kind: 'url' }]);
    expect(input('😀 ', 'historyUndo')).toBe('😀 ');
    expect(ranges).toEqual([]);
    input(text, 'historyRedo');
    expect(ranges).toHaveLength(1);
  });
  it('does not autolink ordinary typing or composition', () => {
    input('😀 https://example.test', 'insertText');
    expect(ranges).toEqual([]);
    input('😀 https://example.test/next', 'insertCompositionText');
    expect(ranges).toEqual([]);
  });
});
