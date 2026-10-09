// @vitest-environment jsdom

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MagpieImportDialog,
  type MagpieImportDialogProps,
  type MagpieImportOption,
} from '../src/components/settings/magpie-import-dialog';
import { initI18n } from '../src/i18n';

const readyOptions: MagpieImportOption[] = [
  { id: 'claude', name: 'Claude-magpie' },
  { id: 'codex', name: 'Codex-magpie' },
  { id: 'pi', name: 'Pi-magpie' },
  { id: 'dsh', name: 'DSH-magpie' },
];

describe('MagpieImportDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const render = async (props: Partial<MagpieImportDialogProps> = {}) => {
    const onOpenChange = props.onOpenChange ?? vi.fn();
    const onImport = props.onImport ?? vi.fn(async () => {});
    await act(async () => {
      root.render(
        <MagpieImportDialog
          open
          gatewayUrl="http://127.0.0.1:48723"
          machineName="Studio Mac"
          options={readyOptions}
          {...props}
          onOpenChange={onOpenChange}
          onImport={onImport}
        />
      );
    });
    return { onOpenChange, onImport };
  };

  const text = () => document.body.textContent ?? '';

  const buttonNamed = (name: string): HTMLButtonElement => {
    const match = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === name
    );
    if (!(match instanceof HTMLButtonElement)) throw new Error(`missing button ${name}`);
    return match;
  };

  const runtimeRow = (name: string): HTMLLabelElement => {
    const match = [...document.querySelectorAll('label')].find((label) =>
      label.textContent?.includes(name)
    );
    if (!(match instanceof HTMLLabelElement)) throw new Error(`missing runtime ${name}`);
    return match;
  };

  const runtimeCheckbox = (name: string): HTMLButtonElement => {
    const box = runtimeRow(name).querySelector('[role="checkbox"]');
    if (!(box instanceof HTMLButtonElement)) throw new Error(`missing checkbox ${name}`);
    return box;
  };

  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
    });
  };

  it('shows this machine, the gateway, and every Magpie runtime selected', async () => {
    const { onImport } = await render();

    expect(text()).toContain('Import Magpie');
    expect(text()).toContain('this machine only');
    expect(text()).toContain('Studio Mac');
    expect(text()).toContain('http://127.0.0.1:48723');
    for (const name of ['Claude-magpie', 'Codex-magpie', 'Pi-magpie', 'DSH-magpie']) {
      expect(runtimeCheckbox(name).getAttribute('aria-checked')).toBe('true');
    }
    expect(onImport).not.toHaveBeenCalled();
  });

  it('names this machine when the host has no machine name', async () => {
    await render({ machineName: undefined });
    expect(text()).toContain('This machine');
  });

  it('leaves a disabled runtime unchecked and out of the import', async () => {
    const { onImport } = await render({
      options: [
        { id: 'claude', name: 'Claude-magpie' },
        {
          id: 'codex',
          name: 'Codex-magpie',
          disabledReason: 'Codex CLI is not installed on this machine.',
        },
        { id: 'pi', name: 'Pi-magpie' },
      ],
    });

    expect(runtimeCheckbox('Codex-magpie').disabled).toBe(true);
    expect(runtimeCheckbox('Codex-magpie').getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain('Codex CLI is not installed on this machine.');

    await click(buttonNamed('Import'));

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledWith(['claude', 'pi']);
  });

  it('does not submit when every runtime is cleared', async () => {
    const { onImport } = await render();

    for (const name of ['Claude-magpie', 'Codex-magpie', 'Pi-magpie', 'DSH-magpie']) {
      await click(runtimeCheckbox(name));
    }

    const importButton = buttonNamed('Import');
    expect(importButton.disabled).toBe(true);
    await click(importButton);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('submits the remaining runtimes once while the import is in flight', async () => {
    let finish: () => void = () => {};
    const onImport = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await render({ onImport });
    await click(runtimeCheckbox('Pi-magpie'));

    await click(buttonNamed('Import'));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledWith(['claude', 'codex', 'dsh']);
    expect(buttonNamed('Importing…').disabled).toBe(true);
    expect(runtimeCheckbox('Claude-magpie').disabled).toBe(true);

    await click(buttonNamed('Importing…'));
    expect(onImport).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
    });
    expect(buttonNamed('Import').disabled).toBe(false);
    expect(runtimeCheckbox('Pi-magpie').getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the selection when the import fails', async () => {
    const { onImport } = await render({
      onImport: vi.fn(async () => {
        throw new Error('gateway refused');
      }),
    });
    await click(runtimeCheckbox('DSH-magpie'));
    await click(buttonNamed('Import'));

    expect(onImport).toHaveBeenCalledWith(['claude', 'codex', 'pi']);
    expect(text()).toContain('gateway refused');
    expect(runtimeCheckbox('DSH-magpie').getAttribute('aria-checked')).toBe('false');
    expect(runtimeCheckbox('Claude-magpie').getAttribute('aria-checked')).toBe('true');
  });

  it('shows the host error without changing the selection', async () => {
    await render();
    await click(runtimeCheckbox('Codex-magpie'));
    await render({
      error: 'Could not write the import.',
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not write the import.'
    );
    expect(runtimeCheckbox('Codex-magpie').getAttribute('aria-checked')).toBe('false');
    expect(runtimeCheckbox('Claude-magpie').getAttribute('aria-checked')).toBe('true');
  });

  it('resets the selection when the dialog closes and opens again', async () => {
    await render();
    await click(runtimeCheckbox('Claude-magpie'));
    expect(runtimeCheckbox('Claude-magpie').getAttribute('aria-checked')).toBe('false');

    await render({ open: false });
    await render({ open: true });

    expect(runtimeCheckbox('Claude-magpie').getAttribute('aria-checked')).toBe('true');
    expect(runtimeCheckbox('DSH-magpie').getAttribute('aria-checked')).toBe('true');
  });

  it('drops a click when a new link arrives before the import microtask', async () => {
    const previous = vi.fn(async () => {});
    const next = vi.fn(async () => {});
    await render({
      onImport: previous,
      requestKey: 'link-1',
      gatewayUrl: 'http://127.0.0.1:1',
    });
    await click(runtimeCheckbox('Pi-magpie'));

    flushSync(() => {
      buttonNamed('Import').click();
    });
    flushSync(() => {
      root.render(
        <MagpieImportDialog
          open
          onOpenChange={vi.fn()}
          onImport={next}
          requestKey="link-2"
          gatewayUrl="http://127.0.0.1:2"
          machineName="Studio Mac"
          options={readyOptions}
        />
      );
    });
    await act(async () => {});

    expect(previous).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(text()).toContain('http://127.0.0.1:2');
    expect(runtimeCheckbox('Pi-magpie').getAttribute('aria-checked')).toBe('true');
    expect(runtimeCheckbox('Claude-magpie').getAttribute('aria-checked')).toBe('true');
  });

  it('resets the selection for a new request on the same gateway', async () => {
    await render({ requestKey: 'link-1' });
    await click(runtimeCheckbox('Pi-magpie'));

    await render({ requestKey: 'link-2' });

    expect(runtimeCheckbox('Pi-magpie').getAttribute('aria-checked')).toBe('true');
  });
});
