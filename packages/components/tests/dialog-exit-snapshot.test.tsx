// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { useDialogExitSnapshot } from '../src/hooks/use-dialog-exit-snapshot';
import { Dialog } from '../src/ui/dialog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The panel's exit transition, held until the test lets it finish. Base UI
 * waits on `getAnimations()` before it reports a close complete; jsdom has none,
 * so the test supplies one whose `finished` it resolves itself.
 */
function holdExitAnimation(): { finish: () => void; restore: () => void } {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [{ finished, pending: false, playState: 'running' }],
  });
  return {
    finish,
    restore: () => {
      if (original) Object.defineProperty(Element.prototype, 'getAnimations', original);
      else delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    },
  };
}

async function frames(count = 3): Promise<void> {
  await act(async () => {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

function RoleEditor() {
  const [editor, setEditor] = useState<{ name: string } | null>({ name: 'Reviewer' });
  const { shown, onOpenChangeComplete } = useDialogExitSnapshot(editor);
  return (
    <Dialog.Root
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open) setEditor(null);
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog.Content>
        <Dialog.Title>Edit Role</Dialog.Title>
        {shown ? <input aria-label="Name" defaultValue={shown.name} /> : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}

describe('useDialogExitSnapshot', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  let hold: ReturnType<typeof holdExitAnimation> | null = null;

  afterEach(async () => {
    hold?.restore();
    hold = null;
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it('keeps the closing panel drawn with its body until the exit finishes', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<RoleEditor />));
    await frames();

    const name = () => document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    expect(name()?.value).toBe('Reviewer');

    hold = holdExitAnimation();
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    await frames();

    // Closed, fading: the panel is still there and so is what it held.
    const panel = document.querySelector('[role="dialog"]');
    expect(panel?.hasAttribute('data-ending-style')).toBe(true);
    expect(name()?.value).toBe('Reviewer');

    await act(async () => hold!.finish());
    await frames();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(name()).toBeNull();
  });
});
