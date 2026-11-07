import { Skeleton } from '../src/feedback/skeleton';
import { Spinner } from '../src/feedback/spinner';

import * as stylex from '@stylexjs/stylex';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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

describe('Spinner', () => {
  test('a changing diameter sizes the same turning box and leaves SVG attributes on the glyph', async () => {
    const errors: unknown[][] = [];
    const errorLog = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));
    let glyph: SVGSVGElement | null = null;
    const ref = (element: SVGSVGElement | null) => {
      glyph = element;
    };
    try {
      mounted = await mount(<Spinner ref={ref} diameter={14} width={37} height={31} />);
      const box = mounted.container.querySelector<HTMLElement>('[data-slot="spinner"]')!;
      const svg = box.firstElementChild;
      const sizes = () => Array.from(box.style).map((name) => box.style.getPropertyValue(name));
      expect(new Set(sizes())).toEqual(new Set(['14px']));
      expect(glyph).toBe(svg);
      expect(svg?.getAttribute('width')).toBe('37');
      expect(svg?.getAttribute('height')).toBe('31');
      expect(box.hasAttribute('diameter')).toBe(false);
      expect(svg?.hasAttribute('diameter')).toBe(false);

      await step(() => mounted!.root.render(<Spinner ref={ref} diameter={0} label={null} />));
      expect(new Set(sizes())).toEqual(new Set(['0px']));
      expect(glyph).toBe(svg);
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      await step(() => mounted!.root.render(<Spinner ref={ref} size="large" />));
      expect(box.style.length).toBe(0);
      expect(glyph).toBe(svg);
      expect(svg?.getAttribute('aria-label')).toBe('Loading');
      await step(() =>
        mounted!.root.render(<Spinner ref={ref} diameter="calc(var(--spacing) * 3.5)" />)
      );
      expect(new Set(sizes())).toEqual(new Set(['calc(var(--spacing) * 3.5)']));
      expect(mounted.container.querySelector('[data-slot="spinner"]')).toBe(box);
      expect(glyph).toBe(svg);
      expect(errors).toEqual([]);
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe('Skeleton', () => {
  test('ring thickness resets without remounting content or leaking onto other shapes', async () => {
    const ref = createRef<HTMLDivElement>();
    const child = <span data-skeleton-child>Retained content</span>;
    mounted = await mount(
      <Skeleton ref={ref} shape="ring" inline width={96} height={48} strokeWidth={7}>
        {child}
      </Skeleton>
    );
    const element = ref.current!;
    const content = element.querySelector('[data-skeleton-child]');
    const values = () =>
      Array.from(element.style).map((name) => element.style.getPropertyValue(name));
    expect(values()).toEqual(expect.arrayContaining(['96px', '48px', '7px']));
    await step(() =>
      mounted!.root.render(
        <Skeleton ref={ref} shape="ring" width={96} height={48} strokeWidth={0}>
          {child}
        </Skeleton>
      )
    );
    expect(values()).toEqual(expect.arrayContaining(['96px', '48px', '0px']));
    await step(() =>
      mounted!.root.render(
        <Skeleton ref={ref} shape="ring" width={96} height={48}>
          {child}
        </Skeleton>
      )
    );
    expect(values()).toHaveLength(2);
    await step(() =>
      mounted!.root.render(
        <Skeleton ref={ref} shape="circle" width={96} height={48} strokeWidth={7}>
          {child}
        </Skeleton>
      )
    );
    expect(values()).toHaveLength(2);
    expect(ref.current).toBe(element);
    expect(element.querySelector('[data-skeleton-child]')).toBe(content);
    expect(element.hasAttribute('stroke-width')).toBe(false);
    expect(element.hasAttribute('strokewidth')).toBe(false);
    expect(element.getAttribute('aria-hidden')).toBe('true');
    for (const shape of ['bar', 'tile'] as const) {
      await step(() =>
        mounted!.root.render(
          <Skeleton ref={ref} shape={shape} inline={false} width={0}>
            {child}
          </Skeleton>
        )
      );
      expect(values()).toEqual(['0px']);
      expect(ref.current).toBe(element);
      expect(element.querySelector('[data-skeleton-child]')).toBe(content);
      expect(element.hasAttribute('inline')).toBe(false);
      expect(element.hasAttribute('shape')).toBe(false);
    }
  });

  test('optional sizes can change without invalid style atoms or stale inline dimensions', async () => {
    const errors: unknown[][] = [];
    const errorLog = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));
    try {
      mounted = await mount(<Skeleton width={96} />);
      const element = mounted.container.querySelector('div')!;
      const values = () =>
        Array.from(element.style).map((name) => element.style.getPropertyValue(name));
      expect(values()).toEqual(['96px']);
      await step(() => mounted!.root.render(<Skeleton height={28} />));
      expect(values()).toEqual(['28px']);
      await step(() => mounted!.root.render(<Skeleton width="60%" height={0} />));
      expect(values()).toEqual(expect.arrayContaining(['60%', '0px']));
      expect(values()).toHaveLength(2);
      await step(() => mounted!.root.render(<Skeleton />));
      expect(element.style.length).toBe(0);
      expect(element.getAttribute('aria-hidden')).toBe('true');
      expect(errors).toEqual([]);
    } finally {
      errorLog.mockRestore();
    }
  });
});
