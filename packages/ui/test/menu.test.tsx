import * as stylex from '@stylexjs/stylex';
import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ContextMenu } from '../src/menu/context-menu';
import { Menu } from '../src/menu/menu';
import { Menubar } from '../src/menu/menubar';
import { PopupContainerProvider } from '../src/popup/portal-container';
import { surface } from '../src/popup/surface';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, click, hover, mount, one, press, step, type Mounted } from './dom';

/**
 * The classes StyleX compiled a style into, which is what lands on the node.
 *
 * `stylex.props` types its arguments against the style objects the compiler
 * produced, and a variadic forward of them widens to `never`; the call is the
 * same one the primitives make, so the signature is loosened here rather than
 * every assertion repeating it.
 */
function classesFor(...styles: readonly unknown[]): string[] {
  const props = stylex.props as (...args: readonly unknown[]) => { className?: string };
  return (props(...styles).className ?? '').split(' ').filter(Boolean);
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const trigger = () => one('button[aria-haspopup="menu"]');
/** Base UI's Popup is the element carrying the menu role. */
const popups = () => all('[role="menu"]');
const popup = () => popups()[0];
/**
 * The rows of an open menu. Scoped to the popup on purpose: a menubar trigger
 * is a `menuitem` of the bar, so an unscoped query would count the names on the
 * bar among the commands in the menu one of them opened.
 */
const items = () => all('[role="menu"] [role="menuitem"]');
const rows = (role: string) => all(`[role="menu"] [role="${role}"]`);
const rowNamed = (label: string) => {
  const row = all(
    '[role="menu"] [role="menuitem"],[role="menu"] [role="menuitemcheckbox"],[role="menu"] [role="menuitemradio"]'
  ).find((node) => node.textContent?.includes(label));
  if (!row) throw new Error(`no row named ${label}`);
  return row;
};

function Actions({
  children,
  ...rest
}: { children?: ReactNode } & ComponentProps<typeof Menu.Root>) {
  return (
    <Menu.Root {...rest}>
      <Menu.Trigger>Actions</Menu.Trigger>
      <Menu.Content>{children}</Menu.Content>
    </Menu.Root>
  );
}

describe('Menu', () => {
  test('is a button that announces the menu it opens, and opens it', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Item>Rename</Menu.Item>
        <Menu.Item>Duplicate</Menu.Item>
      </Actions>
    );
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(popups()).toHaveLength(0);

    await click(trigger());

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(items().map((node) => node.textContent)).toEqual(['Rename', 'Duplicate']);
  });

  test('runs the row that is clicked and closes behind it', async () => {
    const rename = vi.fn();
    mounted = await mount(
      <Actions>
        <Menu.Item onClick={rename}>Rename</Menu.Item>
      </Actions>
    );
    await click(trigger());
    await click(rowNamed('Rename'));

    expect(rename).toHaveBeenCalledTimes(1);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  test('opens onto its first row and walks down from there', async () => {
    const duplicate = vi.fn();
    mounted = await mount(
      <Actions>
        <Menu.Item>Rename</Menu.Item>
        <Menu.Item onClick={duplicate}>Duplicate</Menu.Item>
      </Actions>
    );
    await click(trigger());
    // The first row is already where the keyboard is, so one step reaches the
    // second; a menu that opened onto nothing would need two.
    expect(document.activeElement?.textContent).toBe('Rename');

    await press('ArrowDown');
    await press('Enter');

    expect(duplicate).toHaveBeenCalledTimes(1);
  });

  test('a disabled row is neither reached by the keyboard nor run by a click', async () => {
    const archive = vi.fn();
    mounted = await mount(
      <Actions>
        <Menu.Item disabled onClick={archive}>
          Archive
        </Menu.Item>
        <Menu.Item>Rename</Menu.Item>
      </Actions>
    );
    await click(trigger());

    // The menu opens onto the first row the keyboard can reach, which is the
    // one below the disabled one.
    expect(document.activeElement?.textContent).toBe('Rename');

    await click(rowNamed('Archive'));

    expect(archive).not.toHaveBeenCalled();
    expect(rowNamed('Archive').getAttribute('data-disabled')).toBe('');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  test('the row the pointer is on is the row the keyboard is on', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Item>Rename</Menu.Item>
        <Menu.Item>Duplicate</Menu.Item>
      </Actions>
    );
    await click(trigger());
    await hover(rowNamed('Duplicate'));

    // Base UI moves DOM focus onto the highlighted row, which is the one fact
    // the fill draws; there is no second hover state to disagree with it.
    expect(rowNamed('Duplicate').getAttribute('data-highlighted')).toBe('');
    expect(rowNamed('Rename').hasAttribute('data-highlighted')).toBe(false);
    expect(document.activeElement).toBe(rowNamed('Duplicate'));
  });

  test('the highlight is a class the row gains, so the fill can follow it', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Item>Rename</Menu.Item>
        <Menu.Item>Duplicate</Menu.Item>
      </Actions>
    );
    await click(trigger());
    const resting = classesOf(rowNamed('Duplicate'));
    await hover(rowNamed('Duplicate'));

    expect(classesOf(rowNamed('Duplicate')).filter((name) => !resting.includes(name))).toHaveLength(
      1
    );
  });
});

describe('Menu row', () => {
  test('a destructive row says so in its own colour, not only in its words', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Item>Rename</Menu.Item>
        <Menu.Item>Duplicate</Menu.Item>
        <Menu.Item tone="destructive">Delete</Menu.Item>
      </Actions>
    );
    await click(trigger());
    // Against the second row rather than the first: a menu opens onto its first
    // row, so that one already carries the highlight.
    const neutral = classesOf(rowNamed('Duplicate'));
    const destructive = classesOf(rowNamed('Delete'));

    expect(rowNamed('Delete').getAttribute('data-tone')).toBe('destructive');
    // One class differs: the label colour. Everything else about the row — its
    // height, its radius, its type — is the row every other command takes.
    expect(destructive.filter((name) => !neutral.includes(name))).toHaveLength(1);
  });

  test('a destructive row takes a fill of its own where the keyboard is', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Item tone="destructive">Delete</Menu.Item>
        <Menu.Item>Rename</Menu.Item>
      </Actions>
    );
    await click(trigger());
    await hover(rowNamed('Delete'));
    const underDestructive = classesOf(rowNamed('Delete')).filter(
      (name) => !classesFor(surface.item, surface.itemDestructive).includes(name)
    );
    await hover(rowNamed('Rename'));
    const underNeutral = classesOf(rowNamed('Rename')).filter(
      (name) => !classesFor(surface.item).includes(name)
    );

    // Both rows gain exactly one fill — StyleX keeps one class per property, so
    // the destructive fill replaces the neutral one rather than stacking on it
    // — and the two fills are different, so the highlight cannot say "an
    // ordinary command" under a row that deletes something.
    expect(underDestructive).toHaveLength(1);
    expect(underNeutral).toHaveLength(1);
    expect(underDestructive).not.toEqual(underNeutral);
  });

  test('the leading box is reserved on an inset row so a mixed list lines up', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Item icon={<svg />}>Rename</Menu.Item>
        <Menu.Item inset>Duplicate</Menu.Item>
        <Menu.Item>Archive</Menu.Item>
      </Actions>
    );
    await click(trigger());

    // A row with an icon opens with the box holding it; an inset row opens with
    // the same box, empty and out of the accessibility tree; a plain row starts
    // at its label.
    expect(rowNamed('Rename').firstElementChild?.firstElementChild?.tagName).toBe('svg');
    expect(rowNamed('Duplicate').firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(rowNamed('Duplicate').firstElementChild?.childElementCount).toBe(0);
    expect(rowNamed('Archive').firstElementChild?.textContent).toBe('Archive');
  });

  test('a shortcut sits after the label rather than inside it', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Item shortcut="⌘R">Rename</Menu.Item>
      </Actions>
    );
    await click(trigger());
    const row = rowNamed('Rename');

    expect(row.firstElementChild?.textContent).toBe('Rename');
    expect(row.lastElementChild?.textContent).toBe('⌘R');
  });
});

describe('Menu checkbox and radio rows', () => {
  test('a checkbox row announces its state and toggles without closing the menu', async () => {
    function Toggles() {
      const [notify, setNotify] = useState(false);
      return (
        <Actions>
          <Menu.CheckboxItem checked={notify} onCheckedChange={setNotify}>
            Notify me
          </Menu.CheckboxItem>
        </Actions>
      );
    }
    mounted = await mount(<Toggles />);
    await click(trigger());
    const row = () => rows('menuitemcheckbox')[0];
    expect(row().getAttribute('aria-checked')).toBe('false');

    await click(row());

    expect(row().getAttribute('aria-checked')).toBe('true');
    // A setting is toggled, not chosen: the menu stays up so a second one can
    // be toggled without reopening it.
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  test('a radio group holds one value and marks the row that has it', async () => {
    function Sort() {
      const [order, setOrder] = useState('recent');
      return (
        <Actions>
          <Menu.RadioGroup value={order} onValueChange={setOrder}>
            <Menu.GroupLabel>Sort by</Menu.GroupLabel>
            <Menu.RadioItem value="recent">Recent</Menu.RadioItem>
            <Menu.RadioItem value="name">Name</Menu.RadioItem>
          </Menu.RadioGroup>
        </Actions>
      );
    }
    mounted = await mount(<Sort />);
    await click(trigger());
    const ticked = () => rows('menuitemradio').map((node) => node.getAttribute('aria-checked'));
    expect(ticked()).toEqual(['true', 'false']);

    await click(rowNamed('Name'));

    expect(ticked()).toEqual(['false', 'true']);
  });

  test('the mark is the leading box, so the label cannot slide as the row toggles', async () => {
    mounted = await mount(
      <Actions>
        <Menu.CheckboxItem checked>Notify me</Menu.CheckboxItem>
        <Menu.CheckboxItem>Mute</Menu.CheckboxItem>
      </Actions>
    );
    await click(trigger());

    // Base UI unmounts the tick while a row is unticked, so what has to stay is
    // the box around it: both rows open with the same box, ticked or not, and
    // both boxes carry the same classes.
    const ticked = rowNamed('Notify me').firstElementChild as HTMLElement;
    const unticked = rowNamed('Mute').firstElementChild as HTMLElement;
    expect(classesOf(ticked)).toEqual(classesOf(unticked));
    expect(ticked.childElementCount).toBe(1);
    expect(unticked.childElementCount).toBe(0);
  });
});

describe('Menu group', () => {
  test('a heading names the group it is inside, and needs one to exist', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Group>
          <Menu.GroupLabel>Session</Menu.GroupLabel>
          <Menu.Item>Rename</Menu.Item>
        </Menu.Group>
      </Actions>
    );
    await click(trigger());
    const group = one('[role="menu"] [role="group"]');

    // The heading is the group's accessible name rather than a line of text
    // above it, which is what makes it worth being a part at all.
    expect(document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Session'
    );
  });

  test('a heading outside a group is an error, not a silently plain label', async () => {
    // Pinned because it is the migration trap: Radix's menu label rendered
    // anywhere, so a caller that moves one across without wrapping it in a
    // group gets this at runtime rather than a heading that labels nothing.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        mount(
          <Actions defaultOpen>
            <Menu.GroupLabel>Session</Menu.GroupLabel>
          </Actions>
        )
      ).rejects.toThrow();
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('Menu submenu', () => {
  test('a submenu trigger opens a second menu from the row it is on', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Item>Rename</Menu.Item>
        <Menu.Submenu>
          <Menu.SubmenuTrigger>Export</Menu.SubmenuTrigger>
          <Menu.Content>
            <Menu.Item>PDF</Menu.Item>
            <Menu.Item>PNG</Menu.Item>
          </Menu.Content>
        </Menu.Submenu>
      </Actions>
    );
    await click(trigger());
    expect(popups()).toHaveLength(1);

    await press('ArrowDown');
    await press('ArrowRight');

    expect(popups()).toHaveLength(2);
    expect(items().map((node) => node.textContent)).toContain('PDF');
  });

  test('the row that owns an open submenu keeps its fill', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Submenu>
          <Menu.SubmenuTrigger>Export</Menu.SubmenuTrigger>
          <Menu.Content>
            <Menu.Item>PDF</Menu.Item>
          </Menu.Content>
        </Menu.Submenu>
        <Menu.Submenu>
          <Menu.SubmenuTrigger>Share</Menu.SubmenuTrigger>
          <Menu.Content>
            <Menu.Item>Link</Menu.Item>
          </Menu.Content>
        </Menu.Submenu>
      </Actions>
    );
    await click(trigger());
    await press('ArrowRight');

    expect(rowNamed('Export').getAttribute('data-popup-open')).toBe('');
    // The fill follows the open submenu rather than only the highlight, so the
    // pointer crossing into that submenu does not leave the row it came from
    // dark. It is stated separately from the highlight for that reason, even
    // though the two resolve to the same fill.
    expect(classesOf(rowNamed('Export'))).toEqual(
      expect.arrayContaining(classesFor(surface.itemOpen))
    );
    // The row below it owns nothing and holds nothing: no fill.
    expect(rowNamed('Share').hasAttribute('data-popup-open')).toBe(false);
    expect(classesOf(rowNamed('Share'))).not.toEqual(
      expect.arrayContaining(classesFor(surface.itemOpen))
    );
  });

  test('a submenu trigger says there is more this way, and that it is closed', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Submenu>
          <Menu.SubmenuTrigger>Export</Menu.SubmenuTrigger>
          <Menu.Content>
            <Menu.Item>PDF</Menu.Item>
          </Menu.Content>
        </Menu.Submenu>
      </Actions>
    );
    await click(trigger());
    const submenuTrigger = rowNamed('Export');

    expect(submenuTrigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(submenuTrigger.getAttribute('aria-expanded')).toBe('false');
    // The chevron is drawn by the part, so a caller never has to remember it,
    // and it is hidden from a screen reader that has already been told.
    expect(submenuTrigger.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Menu surface', () => {
  test('a forced palette travels to the portalled menu', async () => {
    mounted = await mount(
      <ThemeRoot mode="dark">
        <Actions>
          <Menu.Item>Rename</Menu.Item>
        </Actions>
      </ThemeRoot>
    );
    await click(trigger());
    // A menu is mounted outside the subtree that declares the palette, so the
    // classes that declare it travel with it and land on the positioner, where
    // they cascade into the popup and its rows.
    const positioner = popup().parentElement as HTMLElement;
    for (const className of forcedThemeClassNames('dark')) {
      expect(classesOf(positioner)).toContain(className);
    }
  });

  test('it mounts into the container a modal named, rather than the document', async () => {
    function InPanel() {
      const panel = useRef<HTMLDivElement>(null);
      return (
        <div ref={panel} data-panel>
          <PopupContainerProvider container={panel}>
            <Actions>
              <Menu.Item>Rename</Menu.Item>
            </Actions>
          </PopupContainerProvider>
        </div>
      );
    }
    mounted = await mount(<InPanel />);
    await click(trigger());

    expect(popup().closest('[data-panel]')).not.toBeNull();
    // A panel that centres itself with `translate` is the containing block for
    // its `position: fixed` descendants, so the popup switches strategies with
    // the container rather than landing at the panel's own offset.
    expect((popup().parentElement as HTMLElement).style.position).toBe('absolute');
  });

  test('the menu and the list a Select opens are one surface, sized differently', async () => {
    mounted = await mount(
      <Actions>
        <Menu.Item>Rename</Menu.Item>
      </Actions>
    );
    await click(trigger());
    const onSurface = classesOf(popup());
    const asList = classesFor(surface.popup);

    // Everything a list brings — the rung, the shadow, the radius, the inset,
    // the type — reaches a menu too, and exactly one of a list's declarations
    // is replaced: the `--anchor-width` it takes from the control it belongs
    // to, which a menu has no equivalent of.
    expect(asList.filter((name) => !onSurface.includes(name))).toHaveLength(1);
    expect(onSurface).toEqual(expect.arrayContaining(classesFor(surface.popupMenu)));
  });
});

describe('ContextMenu', () => {
  test('opens on a right click over the area it was given', async () => {
    mounted = await mount(
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <p>Session</p>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item>Rename</ContextMenu.Item>
          <ContextMenu.Item tone="destructive">Delete</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>
    );
    expect(popups()).toHaveLength(0);

    await step(() => {
      one('p').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 })
      );
    });

    expect(items().map((node) => node.textContent)).toEqual(['Rename', 'Delete']);
  });

  test('its rows are the rows of a dropdown, not a second set of them', async () => {
    mounted = await mount(
      <>
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            <p>Session</p>
          </ContextMenu.Trigger>
          <ContextMenu.Content>
            <ContextMenu.Item>Duplicate</ContextMenu.Item>
            <ContextMenu.Item>Rename</ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
        <Actions>
          <Menu.Item>Duplicate</Menu.Item>
          <Menu.Item>Rename</Menu.Item>
        </Actions>
      </>
    );
    await step(() => {
      one('p').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    // The second row in each, because a menu opens onto its first one and a
    // highlighted row is answering a different question.
    const fromRightClick = classesOf(rowNamed('Rename'));
    await press('Escape');
    await click(trigger());
    const fromButton = classesOf(rowNamed('Rename'));

    // Both are the one row this package defines, so neither can drift into a
    // second appearance for the same command.
    expect(fromRightClick).toEqual(fromButton);
    expect(fromButton).toEqual(expect.arrayContaining(classesFor(surface.item)));
  });

  test('the area it watches adds no box to the layout it was dropped into', async () => {
    mounted = await mount(
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <p>Session</p>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item>Rename</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>
    );
    const wrapper = one('p').parentElement as HTMLElement;

    // A context menu attaches to what the surface already laid out, so its
    // wrapper takes no box: a wrapper with a layout of its own would change
    // that layout just by being asked for a menu. StyleX compiles a declaration
    // to one class per property and value, so the class a `display: contents`
    // written here compiles to is the class the wrapper must be carrying.
    expect(classesOf(wrapper)).toEqual(expect.arrayContaining(classesFor(reference.contents)));
  });
});

/** Written out so a test asserts the declaration rather than the primitive's own constant. */
const reference = stylex.create({ contents: { display: 'contents' } });

describe('Menubar', () => {
  function Bar() {
    return (
      <Menubar.Root>
        <Menubar.Menu>
          <Menubar.Trigger>File</Menubar.Trigger>
          <Menubar.Content>
            <Menubar.Item>New</Menubar.Item>
          </Menubar.Content>
        </Menubar.Menu>
        <Menubar.Menu>
          <Menubar.Trigger>Edit</Menubar.Trigger>
          <Menubar.Content>
            <Menubar.Item>Undo</Menubar.Item>
          </Menubar.Content>
        </Menubar.Menu>
      </Menubar.Root>
    );
  }

  const names = () => all('[role="menubar"] button[aria-haspopup="menu"]');

  test('is a bar of names, each opening its own menu', async () => {
    mounted = await mount(<Bar />);
    expect(names().map((node) => node.textContent)).toEqual(['File', 'Edit']);

    await click(names()[1]);

    expect(items().map((node) => node.textContent)).toEqual(['Undo']);
  });

  test('the name holding the open menu keeps the fill a row takes', async () => {
    mounted = await mount(<Bar />);
    const file = names()[0];
    const closed = classesOf(file);

    await click(file);

    expect(file.getAttribute('aria-expanded')).toBe('true');
    expect(classesOf(file).filter((name) => !closed.includes(name))).toHaveLength(1);
  });

  test('with a menu open the arrows walk the bar rather than the rows', async () => {
    mounted = await mount(<Bar />);
    await click(names()[0]);
    expect(items().map((node) => node.textContent)).toEqual(['New']);

    await press('ArrowRight');

    expect(items().map((node) => node.textContent)).toEqual(['Undo']);
  });
});
