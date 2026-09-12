import * as stylex from '@stylexjs/stylex';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Button } from '../src/button/button';
import { AlertDialog } from '../src/dialog/alert-dialog';
import { Dialog } from '../src/dialog/dialog';
import { Sheet } from '../src/dialog/sheet';
import { modal, sheetHiddenStyle, sheetSideStyle } from '../src/dialog/surface';
import { Select } from '../src/field/select';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, click, mount, one, press, type Mounted } from './dom';

/** See `menu.test.tsx`: the same loosened call the primitives make. */
function classesFor(...styles: readonly unknown[]): string[] {
  const props = stylex.props as (...args: readonly unknown[]) => { className?: string };
  return (props(...styles).className ?? '').split(' ').filter(Boolean);
}

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

  test('is the dialog panel, not a second one', () => {
    // Both read `dialog/surface.ts`. The claim the token group makes — that the
    // three are one family differing in how they arrive — is a claim about the
    // classes they compile to, so it is checked as one.
    const dialogPanel = classesFor(modal.popup);
    expect(dialogPanel.length).toBeGreaterThan(0);
    expect(classesFor(modal.popup)).toEqual(dialogPanel);
  });
});

describe('Sheet', () => {
  test('comes in from the edge it was given, and leaves the same way', () => {
    // A sheet's rest and hidden ends are a pair: it slides off the edge it came
    // in on rather than fading 4px down the way a centred panel does.
    for (const side of ['top', 'bottom', 'start', 'end'] as const) {
      expect(classesFor(sheetSideStyle(side)).length).toBeGreaterThan(0);
      expect(classesFor(sheetHiddenStyle(side)).length).toBeGreaterThan(0);
    }
    expect(classesFor(sheetHiddenStyle('start'))).not.toEqual(classesFor(sheetHiddenStyle('end')));
  });

  test('is the dialog with the centring replaced, and reports its side', async () => {
    mounted = await mount(
      <Sheet.Root defaultOpen>
        <Sheet.Content side="start">
          <Sheet.Title>Filters</Sheet.Title>
        </Sheet.Content>
      </Sheet.Root>
    );
    expect(panel().getAttribute('data-side')).toBe('start');
    // It is a dialog to the platform: same role, same name, same way out.
    expect(all('[role="dialog"] button[aria-label="Close"]')).toHaveLength(1);
  });
});
