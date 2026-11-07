import { createRef } from 'react';

import { step } from './dom';
import * as stylex from '@stylexjs/stylex';
import { act, useRef, useState, type ComponentProps, type ReactNode } from 'react';

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ContextMenu } from '../src/menu/context-menu';
import { Menu, type MenuContentProps } from '../src/menu/menu';
import { Menubar } from '../src/menu/menubar';
import { PopupContainerProvider } from '../src/popup/portal-container';

import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, click, hover, mount, one, press, type Mounted } from './dom';

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

  test.each(['menu', 'context'] as const)(
    '%s bounds preserve the popup, its selected value and positioner ownership',
    async (kind) => {
      const Parts = kind === 'menu' ? Menu : ContextMenu;
      const positionerRef = createRef<HTMLDivElement>();
      function Subject(bounds: Pick<MenuContentProps, 'minWidth' | 'maxWidth' | 'maxHeight'>) {
        const [checked, setChecked] = useState(false);
        const [applied, setApplied] = useState(false);
        const [open, setOpen] = useState(true);
        return (
          <>
            <output data-bounds-result data-bounds-open={open}>
              {applied ? 'applied' : 'waiting'}
            </output>
            <Parts.Root open={open} onOpenChange={setOpen}>
              <Parts.Trigger>Bounded actions</Parts.Trigger>
              <Parts.Content ref={positionerRef} style={{ minWidth: 97 }} {...bounds}>
                <Parts.CheckboxItem
                  checked={checked}
                  onCheckedChange={setChecked}
                  closeOnClick={false}
                >
                  Keep selected
                </Parts.CheckboxItem>
                <Parts.Item onClick={() => setApplied(true)}>Apply</Parts.Item>
              </Parts.Content>
            </Parts.Root>
          </>
        );
      }
      mounted = await mount(<Subject minWidth={190} maxWidth={280} maxHeight="8rem" />);
      const originalPopup = popups()[0]!;
      const positioner = positionerRef.current!;
      const checkbox = one('[role="menuitemcheckbox"]');
      await click(checkbox);
      expect(checkbox.getAttribute('aria-checked')).toBe('true');
      for (const bounds of [{ minWidth: 0, maxWidth: 0, maxHeight: 0 }, {}]) {
        await step(() => mounted!.root.render(<Subject {...bounds} />));
        expect(popups()[0]).toBe(originalPopup);
        expect(one('[role="menuitemcheckbox"]')).toBe(checkbox);
        expect(checkbox.getAttribute('aria-checked')).toBe('true');
        expect(positionerRef.current).toBe(positioner);
        expect(positioner.contains(originalPopup)).toBe(true);
        expect(positioner.style.minWidth).toBe('97px');
        for (const node of [positioner, originalPopup]) {
          for (const name of ['minwidth', 'maxwidth', 'maxheight']) {
            expect(node.hasAttribute(name)).toBe(false);
          }
        }
      }
      await click(rowNamed('Apply'));
      expect(one('[data-bounds-result]').textContent).toBe('applied');
      expect(one('[data-bounds-result]').getAttribute('data-bounds-open')).toBe('false');
    }
  );
});

describe('Menu checkbox and radio rows', () => {
  test.each(['start', 'end'] as const)(
    'a checkbox row with its mark at %s toggles by pointer and keyboard without closing',
    async (indicatorSide) => {
      function Toggles() {
        const [notify, setNotify] = useState(false);
        return (
          <Actions>
            <Menu.CheckboxItem
              checked={notify}
              onCheckedChange={setNotify}
              indicatorSide={indicatorSide}
            >
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
      await press('Enter');
      expect(row().getAttribute('aria-checked')).toBe('false');
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
    }
  );
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
});

/** Written out so a test asserts the declaration rather than the primitive's own constant. */
const reference = stylex.create({ contents: { display: 'contents' } });

describe('ContextMenu', () => {
  test('a rendered trigger preserves its box and forwards the anchor ref', async () => {
    vi.useFakeTimers();
    try {
      let anchor: HTMLDivElement | null = null;
      mounted = await mount(
        <ContextMenu.Root>
          <ContextMenu.Trigger
            ref={(element) => {
              anchor = element;
            }}
            render={<div data-anchor />}
          >
            Workspace
          </ContextMenu.Trigger>
          <ContextMenu.Content>
            <ContextMenu.Item>Open in new window</ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
      );
      const row = one('[data-anchor]');
      expect(anchor).toBe(row);
      expect(classesOf(row)).not.toEqual(expect.arrayContaining(classesFor(reference.contents)));
      await act(async () => {
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(rowNamed('Open in new window')).toBeDefined();
    } finally {
      await mounted?.unmount();
      mounted = undefined;
      vi.useRealTimers();
    }
  });
});

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

  test('with a menu open the arrows walk the bar rather than the rows', async () => {
    mounted = await mount(<Bar />);
    await click(names()[0]);
    expect(items().map((node) => node.textContent)).toEqual(['New']);

    await press('ArrowRight');

    expect(items().map((node) => node.textContent)).toEqual(['Undo']);
  });
});
