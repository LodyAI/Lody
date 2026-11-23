import * as stylex from '@stylexjs/stylex';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Alert } from '../src/feedback/alert';
import { Progress } from '../src/feedback/progress';

import { feedbackSurface as surface } from '../src/feedback/surface';
import { Toast } from '../src/feedback/toast';
import { roleForTone } from '../src/feedback/tone';
import { all, classesOf, mount, one, step, type Mounted } from './dom';

/** See `menu.test.tsx`: the same loosened call the primitives make. */
function classesFor(...styles: readonly unknown[]): string[] {
  const props = stylex.props as (...args: readonly unknown[]) => { className?: string };
  return (props(...styles).className ?? '').split(' ').filter(Boolean);
}

function attrOf(html: string, tag: string, attribute: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  return new RegExp(`${attribute}="([^"]*)"`).exec(open)?.[1];
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

describe('Alert', () => {
  test('how urgently it is announced follows from what it reports', () => {
    // A failure interrupts what a screen reader is saying; a confirmation waits
    // its turn. `alert` on every message is the version that trains people to
    // ignore it, so the role is the tone's rather than a prop.
    expect(roleForTone('danger')).toBe('alert');
    expect(roleForTone('warning')).toBe('alert');
    expect(roleForTone('success')).toBe('status');
    expect(roleForTone('neutral')).toBe('status');
    expect(attrOf(renderToStaticMarkup(<Alert.Root tone="danger" />), 'div', 'role')).toBe('alert');
    expect(attrOf(renderToStaticMarkup(<Alert.Root />), 'div', 'role')).toBe('status');
  });
});

describe('Progress', () => {
  test('no value is a different report from no progress', () => {
    const html = renderToStaticMarkup(<Progress value={null} />);
    expect(html).not.toContain('aria-valuenow');
    // No inline share: Base UI writes one only when there is a value, which is
    // what leaves the indeterminate style free to set a width of its own.
    expect(html).not.toMatch(/style="[^"]*width:\s*\d+%/);
    // The band that crosses the track instead: the indeterminate style, which
    // also drops the width transition that would otherwise fight the animation.
    for (const name of classesFor(surface.indicatorIndeterminate)) {
      expect(html, `an indeterminate bar is missing ${name}`).toContain(name);
    }
  });
});

describe('Toast', () => {
  test('a timed message disappears without interacting with it', async () => {
    vi.useFakeTimers();
    const manager = Toast.createManager();
    mounted = await mount(<Toast.Provider manager={manager} />);
    await act(async () => {
      manager.add({ title: 'Copied' });
    });
    expect(document.body.textContent).toContain('Copied');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(document.body.textContent).not.toContain('Copied');
  });

  test.each(['pointerup', 'pointercancel'])(
    'touch compatibility mouse events do not leave the timeout paused after %s',
    async (endEvent) => {
      vi.useFakeTimers();
      const manager = Toast.createManager();
      mounted = await mount(<Toast.Provider manager={manager} />);
      await act(async () => {
        manager.add({ title: 'Copied' });
      });
      const toast = one('[role="dialog"]');
      await act(async () => {
        toast.dispatchEvent(
          new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' })
        );
        toast.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })
        );
        toast.dispatchEvent(new PointerEvent(endEvent, { bubbles: true, pointerType: 'touch' }));
        toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        toast.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(document.body.textContent).not.toContain('Copied');
    }
  );

  test('a persistent message stays until dismissed', async () => {
    vi.useFakeTimers();
    const manager = Toast.createManager();
    mounted = await mount(<Toast.Provider manager={manager} />);
    await act(async () => {
      manager.add({ title: 'Copied', timeout: 0 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(document.body.textContent).toContain('Copied');
    await act(async () => {
      one('button[aria-label="Close"]').click();
    });
    expect(document.body.textContent).not.toContain('Copied');
  });

  test('mouse hover still pauses the timeout until the pointer leaves', async () => {
    vi.useFakeTimers();
    const manager = Toast.createManager();
    mounted = await mount(<Toast.Provider manager={manager} />);
    await act(async () => {
      manager.add({ title: 'Copied' });
    });
    const toast = one('[role="dialog"]');
    await act(async () => {
      toast.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(document.body.textContent).toContain('Copied');
    await act(async () => {
      toast.dispatchEvent(
        new PointerEvent('pointerout', {
          bubbles: true,
          pointerType: 'mouse',
          relatedTarget: document.body,
        })
      );
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(document.body.textContent).not.toContain('Copied');
  });

  const report = async (
    manager: ReturnType<typeof Toast.createManager>,
    options: Parameters<ReturnType<typeof Toast.createManager>['add']>[0]
  ) => {
    await step(() => {
      manager.add(options);
    });
  };

  test('a message reported from outside React arrives, with its tone', async () => {
    const manager = Toast.createManager();
    mounted = await mount(
      <Toast.Provider manager={manager}>
        <p>the app</p>
      </Toast.Provider>
    );
    expect(all('[role="region"]')).toHaveLength(1);

    await report(manager, { title: 'Sync failed', description: 'No answer', type: 'danger' });

    const toast = all('[data-type="danger"]')[0];
    expect(toast.textContent).toContain('Sync failed');
    expect(toast.textContent).toContain('No answer');
    // The same block an Alert is, on the other rung: one message, two surfaces.
    expect(classesOf(toast)).toEqual(
      expect.arrayContaining(classesFor(surface.message, surface.toast))
    );
    // A toast's tone is its mark alone: no tint, so a stack reads as one kind.
    expect(classesOf(toast)).not.toEqual(expect.arrayContaining(classesFor(surface.noticeDanger)));
  });

  test('the region can be named in the product’s own language', async () => {
    const manager = Toast.createManager();
    mounted = await mount(<Toast.Provider manager={manager} label="通知" />);
    // Base UI's default is the English "Notifications", which a translated
    // product has to be able to replace.
    expect(one('[role="region"]').getAttribute('aria-label')).toBe('通知');
  });
});
