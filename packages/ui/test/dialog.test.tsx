import { afterEach, describe, expect, test, vi } from 'vitest';
import { ModalContainerProvider, PopupContainerProvider } from '../src/popup/portal-container';
import { Button } from '../src/button/button';
import { AlertDialog } from '../src/dialog/alert-dialog';
import { Dialog } from '../src/dialog/dialog';
import { Drawer } from '../src/drawer/drawer';
import { Select } from '../src/field/select';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, click, mount, one, press, step, type Mounted } from './dom';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const panels = () => all('[role="dialog"]');
const panel = () => panels()[0];
const alerts = () => all('[role="alertdialog"]');
const buttonNamed = (label: string) => {
  const node = all('button').find((element) => element.textContent?.trim() === label);
  if (!node) throw new Error(`no button named ${label}`);
  return node;
};

describe('Dialog', () => {
  for (const [name, Modal] of [
    ['Dialog', Dialog],
    ['AlertDialog', AlertDialog],
    ['Drawer', Drawer],
  ] as const) {
    test(`${name} retains its named children and focus when a hidden header is shown`, async () => {
      const title = { current: null as HTMLHeadingElement | null };
      const description = { current: null as HTMLParagraphElement | null };
      const view = (visuallyHidden?: boolean) => (
        <Modal.Root defaultOpen>
          <Modal.Content data-header-owner-panel>
            <Modal.Header visuallyHidden={visuallyHidden} className="retained-header-class">
              <Modal.Title ref={title}>Retained header name</Modal.Title>
              <Modal.Description ref={description}>Retained header description</Modal.Description>
            </Modal.Header>
            <input aria-label="Retained header input" defaultValue="Original value" />
          </Modal.Content>
        </Modal.Root>
      );
      mounted = await mount(view(true));
      const popup = one('[data-header-owner-panel]');
      const titleNode = title.current!;
      const descriptionNode = description.current!;
      const header = titleNode.parentElement!;
      const titleId = titleNode.id;
      const descriptionId = descriptionNode.id;
      const input = one('input') as HTMLInputElement;
      await step(() => input.focus());
      input.value = 'Edited value';
      for (const hidden of [false, undefined, true]) {
        await step(() => mounted!.root.render(view(hidden)));
        expect(title.current).toBe(titleNode);
        expect(description.current).toBe(descriptionNode);
        expect(titleNode.parentElement).toBe(header);
        expect(descriptionNode.parentElement).toBe(header);
        expect(header.classList.contains('retained-header-class')).toBe(true);
        expect(header.hasAttribute('visuallyHidden')).toBe(false);
        expect(header.hasAttribute('aria-hidden')).toBe(false);
        expect(titleNode.id).toBe(titleId);
        expect(descriptionNode.id).toBe(descriptionId);
        expect(popup.getAttribute('aria-labelledby')).toBe(titleId);
        expect(popup.getAttribute('aria-describedby')).toBe(descriptionId);
        expect(titleNode.textContent).toBe('Retained header name');
        expect(descriptionNode.textContent).toBe('Retained header description');
        expect(titleNode.hasAttribute('aria-hidden')).toBe(false);
        expect(descriptionNode.hasAttribute('aria-hidden')).toBe(false);
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('Edited value');
      }
    });
  }

  test('hidden names retain their nodes, refs, ids and accessible relationships when shown again', async () => {
    const title = { current: null as HTMLHeadingElement | null };
    const description = { current: null as HTMLParagraphElement | null };
    const view = (visuallyHidden?: boolean) => (
      <Dialog.Root defaultOpen>
        <Dialog.Content data-hidden-name-panel>
          <Dialog.Title
            ref={title}
            render={<h3 style={{ color: 'rebeccapurple' }} />}
            className="retained-title-class"
            style={{ color: 'orange' }}
            visuallyHidden={visuallyHidden}
            data-hidden-name-title
          >
            The retained name
          </Dialog.Title>
          <Dialog.Description ref={description} visuallyHidden={visuallyHidden}>
            The retained description
          </Dialog.Description>
          <input aria-label="Retained input" defaultValue="Original value" />
        </Dialog.Content>
      </Dialog.Root>
    );
    mounted = await mount(view(true));
    const popup = one('[data-hidden-name-panel]');
    const originalTitle = title.current!;
    const originalDescription = description.current!;
    const input = one('input') as HTMLInputElement;
    const titleId = originalTitle.id;
    const descriptionId = originalDescription.id;
    await step(() => input.focus());
    input.value = 'Edited value';
    for (const hidden of [false, undefined, true]) {
      await step(() => mounted!.root.render(view(hidden)));
      expect(title.current).toBe(originalTitle);
      expect(description.current).toBe(originalDescription);
      expect(originalTitle.tagName).toBe('H3');
      expect(originalTitle.classList.contains('retained-title-class')).toBe(true);
      expect(originalTitle.style.color).toBe('rebeccapurple');
      expect(originalTitle.id).toBe(titleId);
      expect(originalDescription.id).toBe(descriptionId);
      expect(popup.getAttribute('aria-labelledby')).toBe(titleId);
      expect(popup.getAttribute('aria-describedby')).toBe(descriptionId);
      expect(originalTitle.textContent).toBe('The retained name');
      expect(originalDescription.textContent).toBe('The retained description');
      expect(originalTitle.hasAttribute('visuallyHidden')).toBe(false);
      expect(originalTitle.hasAttribute('aria-hidden')).toBe(false);
      expect(originalDescription.hasAttribute('aria-hidden')).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('Edited value');
    }
  });

  for (const [name, Modal] of [
    ['Dialog', Dialog],
    ['AlertDialog', AlertDialog],
  ] as const) {
    test(`${name} consumes spacing options without replacing its live panel or caller style`, async () => {
      const ref = { current: null as HTMLDivElement | null };
      const view = (spacing: { padding?: 'default' | 'none'; gap?: 'default' | 'none' }) => (
        <Modal.Root defaultOpen>
          <Modal.Trigger>Reopen spacing test</Modal.Trigger>
          <Modal.Content
            {...spacing}
            ref={ref}
            data-spacing-test="panel"
            width="400px"
            style={(state) => ({ padding: 7, gap: 9, opacity: state.open ? 1 : 0 })}
          >
            <Modal.Title>Spacing contract</Modal.Title>
            <input aria-label="Retained spacing value" defaultValue="Original value" />
            <Modal.Close>Close spacing test</Modal.Close>
          </Modal.Content>
        </Modal.Root>
      );
      mounted = await mount(view({}));
      const node = one('[data-spacing-test="panel"]');
      const input = one('input') as HTMLInputElement;
      input.value = 'Edited value';
      await step(() => input.focus());
      for (const spacing of [
        { padding: 'none', gap: 'default' },
        { padding: 'default', gap: 'none' },
        { padding: 'none', gap: 'none' },
        {},
      ] as const) {
        await step(() => mounted!.root.render(view(spacing)));
        expect(one('[data-spacing-test="panel"]')).toBe(node);
        expect(ref.current).toBe(node);
        expect(one('input')).toBe(input);
        expect(input.value).toBe('Edited value');
        expect(document.activeElement).toBe(input);
        expect(node.hasAttribute('padding')).toBe(false);
        expect(node.hasAttribute('gap')).toBe(false);
        expect(node.style.padding).toBe('7px');
        expect(node.style.gap).toBe('9px');
        expect(node.style.width).toBe('400px');
        expect(node.style.opacity).toBe('1');
      }
      await click(buttonNamed('Close spacing test'));
      expect(all('[data-spacing-test="panel"]')).toHaveLength(0);
      await click(buttonNamed('Reopen spacing test'));
      expect(one('[data-spacing-test="panel"]')).toBe(ref.current);
    });
  }

  test('modal hosts are independent of floating hosts, and explicit containers win', async () => {
    const host = document.createElement('div');
    const floating = document.createElement('div');
    const explicit = document.createElement('div');
    document.body.append(host, floating, explicit);
    try {
      mounted = await mount(
        <ModalContainerProvider container={host}>
          <PopupContainerProvider container={floating}>
            <Dialog.Root defaultOpen>
              <Dialog.Content data-testid="inherited">
                <Dialog.Title>Inherited</Dialog.Title>
              </Dialog.Content>
            </Dialog.Root>
            <Dialog.Root defaultOpen>
              <Dialog.Content container={explicit} data-testid="explicit">
                <Dialog.Title>Explicit</Dialog.Title>
              </Dialog.Content>
            </Dialog.Root>
            <Dialog.Root defaultOpen>
              <Dialog.Content container={null} data-testid="body">
                <Dialog.Title>Body</Dialog.Title>
              </Dialog.Content>
            </Dialog.Root>
          </PopupContainerProvider>
        </ModalContainerProvider>
      );
      expect(host.querySelector('[data-testid="inherited"]')).not.toBeNull();
      expect(explicit.querySelector('[data-testid="explicit"]')).not.toBeNull();
      expect(floating.querySelector('[role="dialog"]')).toBeNull();
      expect(document.querySelector('[data-testid="body"]')).toBeNull();
    } finally {
      await mounted?.unmount();
      mounted = undefined;
      host.remove();
      floating.remove();
      explicit.remove();
    }
  });

  test('a trigger opens the panel, and the panel names itself', async () => {
    mounted = await mount(
      <Dialog.Root>
        <Dialog.Trigger>Rename</Dialog.Trigger>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Rename session</Dialog.Title>
            <Dialog.Description>The name shows in the sidebar.</Dialog.Description>
          </Dialog.Header>
        </Dialog.Content>
      </Dialog.Root>
    );
    expect(panels()).toHaveLength(0);

    await click(one('button'));

    const labelledBy = panel().getAttribute('aria-labelledby');
    const describedBy = panel().getAttribute('aria-describedby');
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Rename session');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
      'The name shows in the sidebar.'
    );
  });

  test('renders the cross by default, and drops it when a panel says so', async () => {
    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content>
          <Dialog.Title>Rename session</Dialog.Title>
        </Dialog.Content>
      </Dialog.Root>
    );
    expect(all('[role="dialog"] button[aria-label="Close"]')).toHaveLength(1);
    await mounted.unmount();

    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content closeButton={false}>
          <Dialog.Title>Rename session</Dialog.Title>
        </Dialog.Content>
      </Dialog.Root>
    );
    expect(all('[role="dialog"] button[aria-label="Close"]')).toHaveLength(0);
  });

  test('the cross closes it, and so does Escape', async () => {
    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content>
          <Dialog.Title>Rename session</Dialog.Title>
        </Dialog.Content>
      </Dialog.Root>
    );
    await click(one('[role="dialog"] button[aria-label="Close"]'));
    expect(panels()).toHaveLength(0);

    await mounted.unmount();
    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content>
          <Dialog.Title>Rename session</Dialog.Title>
        </Dialog.Content>
      </Dialog.Root>
    );
    await press('Escape');
    expect(panels()).toHaveLength(0);
  });

  test('a panel width lands as inline style, alongside a caller style', async () => {
    // The panel states its own `width` in StyleX, so a second `width` class
    // would only win by sheet order. `width` rides the inline `style` instead —
    // the one channel that always follows the panel — and composes with the
    // `style` a caller already passes.
    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content width="640px" style={{ overscrollBehavior: 'contain' }}>
          <Dialog.Title>Rename session</Dialog.Title>
        </Dialog.Content>
      </Dialog.Root>
    );
    expect(panel().style.width).toBe('640px');
    expect(panel().style.overscrollBehavior).toBe('contain');
  });

  test('a panel centred on an element follows that element, inside the window', async () => {
    // jsdom lays nothing out, so the pane's box is stated; what is pinned is
    // the centre the panel is given and the window clamp around it.
    const pane = document.createElement('div');
    let box = { left: 334, width: 752 };
    pane.getBoundingClientRect = () => new DOMRect(box.left, 0, box.width, 700);
    document.body.append(pane);
    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content width="620px" centerOn={pane}>
          <Dialog.Title>Rename session</Dialog.Title>
        </Dialog.Content>
      </Dialog.Root>
    );
    const declared = () => panel().getAttribute('style') ?? '';
    expect(declared()).toContain(', 710px, ');
    expect(declared()).toContain('min(620px, 100vw - ');
    expect(panel().style.width).toBe('620px');

    // The pane moves when the window does, without resizing itself.
    box = { left: 200, width: 752 };
    await step(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(declared()).toContain(', 576px, ');
    pane.remove();
  });

  test('a panel with no element to centre on keeps the window centre', async () => {
    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content width="620px" centerOn={null}>
          <Dialog.Title>Rename session</Dialog.Title>
        </Dialog.Content>
      </Dialog.Root>
    );
    expect(panel().style.width).toBe('620px');
    expect(panel().getAttribute('style') ?? '').not.toContain('inset-inline-start');
  });

  test('a footer answer runs its handler and takes the panel down with it', async () => {
    const save = vi.fn();
    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content>
          <Dialog.Title>Rename session</Dialog.Title>
          <Dialog.Footer>
            <Dialog.Close render={<Button variant="secondary" />}>Cancel</Dialog.Close>
            <Dialog.Close render={<Button />} onClick={save}>
              Save
            </Dialog.Close>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    );
    await click(buttonNamed('Save'));

    expect(save).toHaveBeenCalledTimes(1);
    expect(panels()).toHaveLength(0);
  });

  test('every popup inside it mounts into the panel rather than on the body', async () => {
    // The whole reason `PopupContainerProvider` exists. A modal traps focus and
    // locks the scroll by DOM position, so a list portalled to the body is
    // outside the dialog to the dialog: focus is dragged back the moment it
    // opens and the wheel never reaches it. The panel names itself, so a
    // product surface never has to.
    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content>
          <Dialog.Title>Pick a fruit</Dialog.Title>
          <Select.Root defaultOpen items={[{ value: 'gala', label: 'Gala' }]}>
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="gala">Gala</Select.Item>
            </Select.Content>
          </Select.Root>
        </Dialog.Content>
      </Dialog.Root>
    );
    const list = one('[role="listbox"]');
    expect(list.closest('[role="dialog"]')).toBe(panel());
  });

  test('a dialog opened inside a dialog still renders its own overlay', async () => {
    // Base UI mounts no backdrop for a nested root, which would leave the
    // stacked dialog dimming nothing. Every panel dims what it was opened
    // from, so each open dialog paints one `role="presentation"` overlay.
    mounted = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content>
          <Dialog.Title>Outer</Dialog.Title>
          <Dialog.Root defaultOpen>
            <Dialog.Content>
              <Dialog.Title>Inner</Dialog.Title>
            </Dialog.Content>
          </Dialog.Root>
        </Dialog.Content>
      </Dialog.Root>
    );
    expect(panels()).toHaveLength(2);
    for (const modal of panels()) {
      expect(document.body.contains(modal)).toBe(true);
      expect(modal.parentElement?.closest('[role="dialog"]')).toBeNull();
    }
    // The portal also mounts an internal backdrop for outside-press detection;
    // the veil is the presentation div carrying the open state.
    expect(all('[role="presentation"][data-open]')).toHaveLength(2);
  });

  test('carries a forced palette across the portal, onto the backdrop too', async () => {
    mounted = await mount(
      <ThemeRoot mode="dark">
        <Dialog.Root defaultOpen>
          <Dialog.Content>
            <Dialog.Title>Rename session</Dialog.Title>
          </Dialog.Content>
        </Dialog.Root>
      </ThemeRoot>
    );
    // The portal wraps the backdrop and the panel both, so it is where the
    // classes declaring the palette land: a panel that inherited the document's
    // palette would open light on a dark page.
    const portal = panel().parentElement;
    expect(portal).not.toBeNull();
    for (const className of forcedThemeClassNames('dark')) {
      expect(classesOf(portal as Element)).toContain(className);
    }
  });
});

describe('AlertDialog', () => {
  test('announces itself as one, and has no cross to leave by', async () => {
    mounted = await mount(
      <AlertDialog.Root defaultOpen>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Delete this session?</AlertDialog.Title>
            <AlertDialog.Description>Its transcript goes with it.</AlertDialog.Description>
          </AlertDialog.Header>
        </AlertDialog.Content>
      </AlertDialog.Root>
    );
    expect(alerts()).toHaveLength(1);
    expect(all('button[aria-label="Close"]')).toHaveLength(0);
  });

  test('an outside press does not answer it, but Escape does', async () => {
    mounted = await mount(
      <AlertDialog.Root defaultOpen>
        <AlertDialog.Content>
          <AlertDialog.Title>Delete this session?</AlertDialog.Title>
          <AlertDialog.Footer>
            <AlertDialog.Close render={<Button variant="secondary" />}>Keep</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    );
    // The point of an alert dialog: a stray click beside it is not an answer,
    // so the press that dismisses every other popup leaves this one standing.
    await click(document.body);
    expect(alerts()).toHaveLength(1);

    // Escape still is one. It is the platform's cancel, and taking it away
    // leaves a keyboard user holding a panel they cannot put down.
    await press('Escape');
    expect(alerts()).toHaveLength(0);
  });
});
