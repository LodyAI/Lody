import * as stylex from '@stylexjs/stylex';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';
import { Alert } from '../src/feedback/alert';
import { Progress } from '../src/feedback/progress';
import { Skeleton } from '../src/feedback/skeleton';
import { Spinner } from '../src/feedback/spinner';
import { feedbackSurface as surface } from '../src/feedback/surface';
import { Toast } from '../src/feedback/toast';
import { roleForTone } from '../src/feedback/tone';
import { all, classesOf, click, mount, one, step, type Mounted } from './dom';

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

  test('the mark is the tone’s, and the part draws it', () => {
    // A caller free to pass a glyph can put a tick on a failure, so there is no
    // way to pass one: each tone brings the mark that names it.
    const danger = renderToStaticMarkup(<Alert.Root tone="danger" />);
    const success = renderToStaticMarkup(<Alert.Root tone="success" />);
    const warning = renderToStaticMarkup(<Alert.Root tone="warning" />);
    expect(danger).toContain('<svg');
    expect(
      new Set([danger, success, warning].map((html) => /d="([^"]*)"/.exec(html)?.[1])).size
    ).toBe(3);
    // The warning is the one that is not a circle: a triangle is what tells it
    // from an error for a person who does not see the two colours apart.
    expect(warning).not.toContain('<circle');
    expect(danger).toContain('<circle');
  });

  test('a tone tints the surface it is on, and the two rungs are two surfaces', () => {
    // The tint is 8% of the tone mixed into the rung's own background, so an
    // Alert on the card rung and a Toast on the floating one cannot share one
    // token without one of them ceasing to look like its rung.
    expect(classesFor(surface.noticeDanger)).not.toEqual(classesFor(surface.toastDanger));
    const html = renderToStaticMarkup(<Alert.Root tone="danger" />);
    for (const name of classesFor(surface.message, surface.notice, surface.noticeDanger)) {
      expect(html, `the danger alert is missing ${name}`).toContain(name);
    }
  });
});

describe('Progress', () => {
  test('the bar reports the value, and Base UI owns what it announces', () => {
    const html = renderToStaticMarkup(<Progress value={40} label="Uploading" showValue />);
    expect(attrOf(html, 'div', 'role')).toBe('progressbar');
    expect(attrOf(html, 'div', 'aria-valuenow')).toBe('40');
    expect(html).toContain('Uploading');
    expect(html).toContain('40%');
    // The indicator's width is the value, which Base UI writes inline.
    expect(html).toContain('width:40%');
  });

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

describe('Skeleton', () => {
  test('it says nothing to a screen reader, because its shape says it all', () => {
    expect(attrOf(renderToStaticMarkup(<Skeleton />), 'div', 'aria-hidden')).toBe('true');
  });

  test('the room it holds is a prop, so nothing has to win a specificity fight', () => {
    // A size passed as a class would land in the same fight as the shape's own
    // height; a dynamic style resolves to an inline value instead.
    const html = renderToStaticMarkup(<Skeleton width="60%" height={12} />);
    expect(/style="[^"]*width:\s*60%/.test(html)).toBe(true);
    expect(/style="[^"]*height:\s*12px/.test(html)).toBe(true);
  });

  test('each shape takes its own corner, and nothing else', () => {
    const line = classesFor(surface.skeleton, surface.skeletonLine);
    const circle = classesFor(surface.skeleton, surface.skeletonCircle);
    expect(line).not.toEqual(circle);
    const html = renderToStaticMarkup(<Skeleton shape="circle" />);
    for (const name of circle) {
      expect(html, `a circle skeleton is missing ${name}`).toContain(name);
    }
  });
});

describe('Spinner', () => {
  test('it is drawn in the ink of whatever holds it', () => {
    const html = renderToStaticMarkup(<Spinner />);
    // Two strokes, one colour: the arc and the ring it turns inside, which is
    // that same colour kept back rather than a token of its own.
    expect(html.match(/stroke="currentColor"/g)).toHaveLength(2);
    expect(html).toContain('stroke-opacity="0.25"');
  });

  test('it names itself, unless the surface has already named the wait', () => {
    expect(attrOf(renderToStaticMarkup(<Spinner />), 'svg', 'aria-label')).toBe('Loading');
    const silent = renderToStaticMarkup(<Spinner label={null} />);
    expect(attrOf(silent, 'svg', 'aria-hidden')).toBe('true');
    expect(silent).not.toContain('aria-label');
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
      expect.arrayContaining(classesFor(surface.message, surface.toast, surface.toastDanger))
    );
  });

  test('the title and the sentence under it are the Alert’s, not a second pair', async () => {
    const manager = Toast.createManager();
    mounted = await mount(<Toast.Provider manager={manager} />);
    await report(manager, { title: 'Session archived', description: 'It can be restored.' });
    expect(classesOf(one('h2'))).toEqual(classesFor(surface.title));
    expect(classesOf(one('[data-base-ui-portal] p'))).toEqual(classesFor(surface.description));
  });

  test('the page under a toast stays usable, and the toast itself does not', async () => {
    const manager = Toast.createManager();
    mounted = await mount(<Toast.Provider manager={manager} />);
    await report(manager, { title: 'Saved' });
    // The viewport covers a strip of the window, so it must not take the
    // pointer; each toast takes it back for its own close button.
    expect(classesOf(one('[role="region"]'))).toEqual(
      expect.arrayContaining(classesFor(surface.viewport))
    );
    expect(classesOf(all('[role="dialog"]')[0])).toEqual(
      expect.arrayContaining(classesFor(surface.toast))
    );
  });

  test('closing one takes it away', async () => {
    const manager = Toast.createManager();
    mounted = await mount(<Toast.Provider manager={manager} />);
    await report(manager, { title: 'Saved' });
    expect(all('[role="dialog"]')).toHaveLength(1);

    await click(one('button[aria-label="Close"]'));

    expect(all('[role="dialog"]')).toHaveLength(0);
  });

  test('the region can be named in the product’s own language', async () => {
    const manager = Toast.createManager();
    mounted = await mount(<Toast.Provider manager={manager} label="通知" />);
    // Base UI's default is the English "Notifications", which a translated
    // product has to be able to replace.
    expect(one('[role="region"]').getAttribute('aria-label')).toBe('通知');
  });
});
