import { createRef, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Button } from '../src/button/button';
import { Popover, type PopoverContentProps } from '../src/popover/popover';
import { PopupContainerProvider } from '../src/popup/portal-container';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import {
  all,
  classesOf,
  click,
  mount,
  one,
  press,
  step,
  typeInto,
  until,
  type Mounted,
} from './dom';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const trigger = () => one('button[aria-haspopup="dialog"]');
const panels = () => all('[role="dialog"]');
const panel = () => panels()[0];

describe('Popover', () => {
  test('is a button that announces the surface it opens, and opens it', async () => {
    mounted = await mount(
      <Popover.Root>
        <Popover.Trigger>Filter</Popover.Trigger>
        <Popover.Content>
          <Popover.Title>Filter sessions</Popover.Title>
        </Popover.Content>
      </Popover.Root>
    );
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(panels()).toHaveLength(0);

    await click(trigger());

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(panel().textContent).toContain('Filter sessions');
  });

  test('a title names the surface rather than being read out as its contents', async () => {
    mounted = await mount(
      <Popover.Root defaultOpen>
        <Popover.Trigger>Filter</Popover.Trigger>
        <Popover.Content>
          <Popover.Header>
            <Popover.Title>Filter sessions</Popover.Title>
            <Popover.Description>Applies to the list under it.</Popover.Description>
          </Popover.Header>
        </Popover.Content>
      </Popover.Root>
    );
    const labelledBy = panel().getAttribute('aria-labelledby');
    const describedBy = panel().getAttribute('aria-describedby');
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Filter sessions');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
      'Applies to the list under it.'
    );
  });

  test('a clipped rendered title keeps its ref, identity and accessible name when restored', async () => {
    const titleRef = createRef<HTMLHeadingElement>();
    function Subject() {
      const [visuallyHidden, setVisuallyHidden] = useState<boolean | undefined>();
      return (
        <Popover.Root defaultOpen>
          <Popover.Trigger>Filter</Popover.Trigger>
          <Popover.Content>
            <Popover.Title
              ref={titleRef}
              render={<h3 data-rendered-title />}
              visuallyHidden={visuallyHidden}
            >
              Filter sessions
            </Popover.Title>
            <Button onClick={() => setVisuallyHidden((value) => (value ? undefined : true))}>
              {visuallyHidden ? 'Show title' : 'Clip title'}
            </Button>
          </Popover.Content>
        </Popover.Root>
      );
    }
    mounted = await mount(<Subject />);
    const title = titleRef.current;
    expect(title?.tagName).toBe('H3');
    const id = title?.id;
    const assertNamed = () => {
      expect(titleRef.current).toBe(title);
      expect(title?.id).toBe(id);
      expect(panel().getAttribute('aria-labelledby')).toBe(id);
      expect(document.getElementById(id ?? '')?.textContent).toBe('Filter sessions');
      expect(title?.hasAttribute('hidden')).toBe(false);
      expect(title?.hasAttribute('aria-hidden')).toBe(false);
      expect(title?.hasAttribute('visuallyhidden')).toBe(false);
    };
    assertNamed();
    await click(all('button').find((node) => node.textContent === 'Clip title') as HTMLElement);
    assertNamed();
    await click(all('button').find((node) => node.textContent === 'Show title') as HTMLElement);
    assertNamed();
    await press('Escape');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  test('Escape closes it and the trigger says so again', async () => {
    mounted = await mount(
      <Popover.Root>
        <Popover.Trigger>Filter</Popover.Trigger>
        <Popover.Content>
          <Popover.Title>Filter sessions</Popover.Title>
        </Popover.Content>
      </Popover.Root>
    );
    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    await press('Escape');

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  test('Close runs its own handler and takes the surface down with it', async () => {
    const apply = vi.fn();
    mounted = await mount(
      <Popover.Root>
        <Popover.Trigger>Filter</Popover.Trigger>
        <Popover.Content>
          <Popover.Close render={<Button />} onClick={apply}>
            Apply
          </Popover.Close>
        </Popover.Content>
      </Popover.Root>
    );
    await click(trigger());
    const apply_ = all('[role="dialog"] button').find((node) =>
      node.textContent?.includes('Apply')
    );
    await click(apply_ as HTMLElement);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  test('mounts into the container a modal named, not on the body', async () => {
    function Host() {
      const [host, setHost] = useState<HTMLDivElement | null>(null);
      return (
        <div ref={setHost} data-host="">
          <PopupContainerProvider container={host}>
            <Popover.Root defaultOpen>
              <Popover.Trigger>Filter</Popover.Trigger>
              <Popover.Content>
                <Popover.Title>Filter sessions</Popover.Title>
              </Popover.Content>
            </Popover.Root>
          </PopupContainerProvider>
        </div>
      );
    }
    mounted = await mount(<Host />);
    // A modal traps focus and locks the scroll by DOM position, so a popover
    // portalled to the body is outside the panel that opened it. Naming the
    // panel puts it back inside the subtree the modal is guarding.
    expect(panel().closest('[data-host]')).not.toBeNull();
  });

  test('carries a forced palette across the portal', async () => {
    mounted = await mount(
      <ThemeRoot mode="dark">
        <Popover.Root defaultOpen>
          <Popover.Trigger>Filter</Popover.Trigger>
          <Popover.Content>
            <Popover.Title>Filter sessions</Popover.Title>
          </Popover.Content>
        </Popover.Root>
      </ThemeRoot>
    );
    // The panel is portalled out of the subtree declaring the palette, so the
    // classes that declare it travel with it and land on the positioner above.
    const positioner = panel().parentElement;
    expect(positioner).not.toBeNull();
    for (const className of forcedThemeClassNames('dark')) {
      expect(classesOf(positioner as Element)).toContain(className);
    }
  });

  test('layout changes preserve content and the positioner ref, style and events', async () => {
    const positionerRef = createRef<HTMLDivElement>();
    function Subject({
      padding,
      gap,
      ...dimensions
    }: Pick<
      PopoverContentProps,
      'padding' | 'gap' | 'width' | 'minWidth' | 'maxWidth' | 'maxHeight'
    >) {
      const [open, setOpen] = useState(true);
      const [value, setValue] = useState('Original value');
      const [pointerOwner, setPointerOwner] = useState('none');
      return (
        <>
          <output data-observed>{`${String(open)}; ${pointerOwner}`}</output>
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger>Layout</Popover.Trigger>
            <Popover.Content
              ref={positionerRef}
              data-positioner=""
              style={{ minWidth: 333 }}
              padding={padding}
              gap={gap}
              {...dimensions}
              onPointerEnter={(event) =>
                setPointerOwner(
                  event.currentTarget === positionerRef.current ? 'positioner' : 'other'
                )
              }
            >
              <Popover.Title>Layout panel</Popover.Title>
              <input
                aria-label="Value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <Popover.Close>Done</Popover.Close>
            </Popover.Content>
          </Popover.Root>
        </>
      );
    }
    mounted = await mount(
      <Subject
        padding="default"
        gap="none"
        width={280}
        minWidth={100}
        maxWidth={300}
        maxHeight={180}
      />
    );
    const popup = panel();
    const positioner = positionerRef.current!;
    const input = popup.querySelector('input')!;
    await typeInto(input, 'Edited value');
    await step(() => {
      positioner.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
      );
    });
    expect(one('[data-observed]').textContent).toBe('true; positioner');

    await step(() =>
      mounted!.root.render(
        <Subject padding="none" gap="default" width={0} minWidth={0} maxWidth={0} maxHeight={0} />
      )
    );

    expect(panel()).toBe(popup);
    expect(panel().querySelector('input')).toBe(input);
    expect(input.value).toBe('Edited value');
    expect(positionerRef.current).toBe(positioner);
    expect(positioner.contains(popup)).toBe(true);
    expect(positioner.style.minWidth).toBe('333px');
    expect(popup.style.minWidth).toBe('');
    for (const node of [positioner, popup]) {
      for (const name of ['padding', 'gap', 'width', 'minwidth', 'maxwidth', 'maxheight']) {
        expect(node.hasAttribute(name)).toBe(false);
      }
    }
    expect(document.getElementById(popup.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Layout panel'
    );

    await step(() => mounted!.root.render(<Subject padding="default" gap="default" />));
    expect(panel()).toBe(popup);
    expect(panel().querySelector('input')).toBe(input);
    expect(input.value).toBe('Edited value');

    await click(one('[role="dialog"] button'));
    await until(() => panels().length === 0, 'the layout panel to close');
    expect(one('[data-observed]').textContent).toBe('false; positioner');
    await click(trigger());
    await until(() => panels().length === 1, 'the layout panel to reopen');
    expect(panel().querySelector('input')?.value).toBe('Edited value');
  });
});
