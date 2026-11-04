import { describe, expect, test } from 'vitest';
import { Button } from '../src/button/button';
import { Separator } from '../src/separator/separator';
import { Toggle } from '../src/toggle/toggle';
import { ToggleGroup } from '../src/toggle/toggle-group';

import { Toolbar } from '../src/toggle/toolbar';
import { all, click, mount, press, step, until } from './dom';

function toggles(): HTMLButtonElement[] {
  return all('button[aria-pressed]') as HTMLButtonElement[];
}

describe('ToggleGroup', () => {
  test('one out of several: taking a second releases the first', async () => {
    const taken: string[][] = [];
    const mounted = await mount(
      <ToggleGroup defaultValue={['list']} onValueChange={(next) => taken.push(next)}>
        <Toggle value="list">List</Toggle>
        <Toggle value="board">Board</Toggle>
      </ToggleGroup>
    );
    const [list, board] = toggles();
    expect(list.getAttribute('aria-pressed')).toBe('true');
    await click(board);
    expect(board.getAttribute('aria-pressed')).toBe('true');
    expect(list.getAttribute('aria-pressed')).toBe('false');
    expect(taken.at(-1)).toEqual(['board']);
    await mounted.unmount();
  });

  test('several at once: the set holds every pressed member', async () => {
    // This is the state a Tabs strip cannot describe, and the reason this is a
    // different part rather than a strip without its track: two members are on
    // at the same time, and no single sliding pill can stand for both.
    const mounted = await mount(
      <ToggleGroup multiple defaultValue={['status']}>
        <Toggle value="status">Status</Toggle>
        <Toggle value="assignee">Assignee</Toggle>
      </ToggleGroup>
    );
    const [status, assignee] = toggles();
    await click(assignee);
    expect(status.getAttribute('aria-pressed')).toBe('true');
    expect(assignee.getAttribute('aria-pressed')).toBe('true');
    await mounted.unmount();
  });

  test('the set is one tab stop, and the arrow keys walk it', async () => {
    const mounted = await mount(
      <ToggleGroup multiple>
        <Toggle value="a">A</Toggle>
        <Toggle value="b">B</Toggle>
        <Toggle value="c">C</Toggle>
      </ToggleGroup>
    );
    const members = toggles();
    // One stop: a person tabbing through a page passes the set rather than
    // walking it, which is what makes a set of eight bearable.
    expect(members.filter((member) => member.tabIndex === 0)).toHaveLength(1);
    await step(() => members[0].focus());
    await press('ArrowRight');
    await until(() => document.activeElement === members[1], 'the arrow key to move the focus');
    await mounted.unmount();
  });
});

describe('Toolbar', () => {
  test('a toggle in a bar is still a toggle, and the bar is still one stop', async () => {
    const mounted = await mount(
      <Toolbar.Root aria-label="Format">
        <Toolbar.Button render={<Toggle icon aria-label="Bold" />}>
          <svg />
        </Toolbar.Button>
        <Toolbar.Button render={<Toggle icon aria-label="Italic" />}>
          <svg />
        </Toolbar.Button>
        <Toolbar.Separator />
        <Toolbar.Button render={<Button variant="ghost" icon aria-label="Quote" />}>
          <svg />
        </Toolbar.Button>
      </Toolbar.Root>
    );
    const items = all('[role="toolbar"] button');
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    const bold = items[0];
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    await click(bold);
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    await step(() => bold.focus());
    await press('ArrowRight');
    await until(() => document.activeElement === items[1], 'the arrow key to walk the bar');
    await mounted.unmount();
  });

  test('a control the bar cannot use is stepped over rather than stopped on', async () => {
    const mounted = await mount(
      <Toolbar.Root aria-label="Format">
        <Toolbar.Button render={<Toggle icon aria-label="Bold" />}>
          <svg />
        </Toolbar.Button>
        <Toolbar.Button disabled focusableWhenDisabled={false} render={<Button icon />}>
          <svg />
        </Toolbar.Button>
        <Toolbar.Button render={<Toggle icon aria-label="Code" />}>
          <svg />
        </Toolbar.Button>
      </Toolbar.Root>
    );
    const items = all('[role="toolbar"] button');
    await step(() => items[0].focus());
    await press('ArrowRight');
    await until(
      () => document.activeElement === items[2],
      'the disabled control to be stepped over'
    );
    await mounted.unmount();
  });
});
