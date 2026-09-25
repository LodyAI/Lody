import * as stylex from '@stylexjs/stylex';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Button } from '../src/button/button';
import { Separator } from '../src/separator/separator';
import { Toggle } from '../src/toggle/toggle';
import { ToggleGroup } from '../src/toggle/toggle-group';
import { toggleSurface } from '../src/toggle/surface';
import { Toolbar } from '../src/toggle/toolbar';
import { all, classesOf, click, mount, one, press, step, until } from './dom';

/** The classes one of the family's styles compiles to, for a state check. */
function classesFor(style: (typeof toggleSurface)[keyof typeof toggleSurface]): string[] {
  return (stylex.props(style).className ?? '').split(' ').filter(Boolean);
}

function toggles(): HTMLButtonElement[] {
  return all('button[aria-pressed]') as HTMLButtonElement[];
}

describe('Toggle', () => {
  test('it is a button that says whether it is on', async () => {
    // A toggle is a real `<button>` carrying `aria-pressed`, so the keyboard
    // reaches it and a screen reader is told both what it is and its state —
    // which is the whole difference between this and a div a surface colours.
    const mounted = await mount(<Toggle>Bold</Toggle>);
    const button = one('button');
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await mounted.unmount();
  });

  test('a controlled toggle reports the press and leaves the state to its caller', async () => {
    const seen: boolean[] = [];
    const mounted = await mount(
      <Toggle pressed={false} onPressedChange={(next) => seen.push(next)}>
        Bold
      </Toggle>
    );
    const button = one('button');
    await click(button);
    expect(seen).toEqual([true]);
    // The caller never changed `pressed`, so the control did not change either.
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await mounted.unmount();
  });

  test('off is a ghost control and on is the well, which is the state pair', async () => {
    // The two states are the whole design decision this part makes: off has no
    // fill at all, and on sinks into the well rather than filling with ink,
    // because ink is what a control that already sits in a well becomes.
    const mounted = await mount(<Toggle>Wrap lines</Toggle>);
    const button = one('button');
    for (const name of classesFor(toggleSurface.rest)) {
      expect(classesOf(button), `an off toggle is missing ${name}`).toContain(name);
    }
    await click(button);
    for (const name of classesFor(toggleSurface.pressed)) {
      expect(classesOf(button), `an on toggle is missing ${name}`).toContain(name);
    }
    for (const name of classesFor(toggleSurface.rest)) {
      expect(classesOf(button), `an on toggle still carries ${name}`).not.toContain(name);
    }
    await mounted.unmount();
  });

  test('an icon-only toggle draws the box its glyph fills', () => {
    // This package's icons state their size as 100% of whatever holds them and
    // StyleX has no descendant selector, so the control draws the 16px box —
    // the same contract an icon-only Button has.
    const html = renderToStaticMarkup(
      <Toggle icon aria-label="Bold">
        <svg />
      </Toggle>
    );
    for (const name of classesFor(toggleSurface.glyph)) {
      expect(html, `the glyph box is missing ${name}`).toContain(name);
    }
  });

  test('a disabled toggle is disabled to the platform, not just dimmed', () => {
    const html = renderToStaticMarkup(<Toggle disabled>Bold</Toggle>);
    expect(html).toContain('disabled=""');
  });
});

describe('ToggleGroup', () => {
  test('the set states the size once, and a member may still state its own', () => {
    // A member's height follows from the set's, so a surface states one fact
    // rather than one per member — and two of them cannot disagree by accident.
    const html = renderToStaticMarkup(
      <ToggleGroup size="mini">
        <Toggle value="a">A</Toggle>
        <Toggle value="b" size="large">
          B
        </Toggle>
      </ToggleGroup>
    );
    expect(html).toContain('data-size="mini"');
    expect(html).toContain('data-size="large"');
  });

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
  test('it says what it is, and draws nothing of its own', async () => {
    const mounted = await mount(
      <Toolbar.Root aria-label="Format">
        <Toolbar.Button render={<Toggle icon aria-label="Bold" />}>
          <svg />
        </Toolbar.Button>
      </Toolbar.Root>
    );
    const bar = one('[role="toolbar"]');
    expect(bar.getAttribute('aria-orientation')).toBe('horizontal');
    // The bar carries the row and the gap, and no fill, shadow or radius: what
    // it stands on is the surface the product already had there.
    expect(classesOf(bar)).toEqual(classesFor(toggleSurface.bar));
    // A control joins the walk through `render`, and what it was given to hold
    // arrives inside the box the control draws — the composition every caller
    // writes, and the one place the two halves could fail to meet.
    const glyph = one('[role="toolbar"] button > span');
    for (const name of classesFor(toggleSurface.glyph)) {
      expect(classesOf(glyph), `a composed toggle's glyph box is missing ${name}`).toContain(name);
    }
    expect(glyph.querySelector('svg')).not.toBeNull();
    await mounted.unmount();
  });

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

  test("the bar's line is the one line this system allows, turned ninety degrees", () => {
    // The orientation is the bar's turned, and it is the part's rather than a
    // caller's so that a horizontal bar cannot end up with a horizontal line
    // across it. What it draws is the very same hairline `Separator` draws.
    const html = renderToStaticMarkup(
      <Toolbar.Root>
        <Toolbar.Separator />
      </Toolbar.Root>
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    const line = renderToStaticMarkup(<Separator orientation="vertical" />);
    for (const name of (/class="([^"]*)"/.exec(line)?.[1] ?? '').split(' ').filter(Boolean)) {
      expect(html, `the bar's line is missing ${name}`).toContain(name);
    }
  });
});
