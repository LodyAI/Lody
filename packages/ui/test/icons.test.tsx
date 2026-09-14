import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Icon, createIcon, type IconVariant } from '../src/icons/icon';
import { ICONS, ICON_FAMILIES, ICON_NAMES, type IconName } from '../src/icons/registry';
import {
  BellRingIcon,
  ChevronToggleIcon,
  IconFrame,
  SidebarToggleIcon,
} from '../src/icons/stateful';
import { SidebarIcon } from '../src/icons/index';

const VARIANTS: IconVariant[] = ['outline', 'duotone', 'glyph', 'bulk'];

/** The icons that carry a layer model, and so have four treatments. */
const layered = ICON_NAMES.filter((name) => ICONS[name].layers != null);

describe('the registry', () => {
  test('every family member is drawn, once, under a kebab-case name', () => {
    const listed = Object.values(ICON_FAMILIES).flat();
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...ICON_NAMES].sort());
    for (const name of ICON_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      expect(ICONS[name].marks.length, `${name} draws nothing`).toBeGreaterThan(0);
    }
  });

  test('a layered icon closes its mass, and its dots are dots', () => {
    // The filled variants fill `mass`; an open path would fill along its chord
    // and the glyph would be a different shape from the outline.
    for (const name of layered) {
      const { mass, dots } = ICONS[name].layers!;
      expect(mass.trim().endsWith('z'), `${name}.mass is not closed`).toBe(true);
      if (dots) expect(dots).toMatch(/h\.01/);
    }
  });

  test('the drawing stays on the 24 grid', () => {
    // Absolute commands and every circle and rect state coordinates directly;
    // a value past the canvas is an icon that will be clipped by its own box.
    for (const name of ICON_NAMES) {
      for (const mark of ICONS[name].marks) {
        if ('path' in mark) {
          for (const m of mark.path.matchAll(/[MLHV]([^a-zA-Z]*)/g)) {
            for (const value of m[1].match(/-?\d*\.?\d+/g) ?? []) {
              const n = Number(value);
              expect(n, `${name}: ${value} in ${mark.path}`).toBeGreaterThanOrEqual(0);
              expect(n, `${name}: ${value} in ${mark.path}`).toBeLessThanOrEqual(24);
            }
          }
        } else if ('circle' in mark) {
          const [cx, cy, r] = mark.circle;
          expect(cx - r).toBeGreaterThanOrEqual(0);
          expect(cx + r).toBeLessThanOrEqual(24);
          expect(cy - r).toBeGreaterThanOrEqual(0);
          expect(cy + r).toBeLessThanOrEqual(24);
        } else {
          const [x, y, width, height] = mark.rect;
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x + width).toBeLessThanOrEqual(24);
          expect(y + height).toBeLessThanOrEqual(24);
        }
      }
    }
  });
});

describe('Icon', () => {
  test('is decoration unless it is given something to say', () => {
    const silent = renderToStaticMarkup(<Icon name="sidebar" />);
    expect(silent).toContain('aria-hidden="true"');
    expect(silent).not.toContain('role=');
    const named = renderToStaticMarkup(<Icon name="sidebar" title="Toggle sidebar" />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Toggle sidebar"');
    expect(named).toContain('<title>Toggle sidebar</title>');
    expect(named).not.toContain('aria-hidden');
  });

  test('draws the outline at the set stroke and inherits its colour', () => {
    const html = renderToStaticMarkup(<Icon name="branch" />);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="1.5"');
    expect(html).toContain('stroke-linecap="round"');
    expect(html).not.toContain('fill="currentColor"');
    // A mark may state its own weight: the eyes and the dots of an ellipsis.
    expect(renderToStaticMarkup(<Icon name="more" />)).toContain('stroke-width="2.5"');
  });

  test('an icon without layers is outline in every variant', () => {
    const outline = renderToStaticMarkup(<Icon name="branch" />);
    for (const variant of VARIANTS) {
      const html = renderToStaticMarkup(<Icon name="branch" variant={variant} />);
      expect(html).toContain('data-variant="outline"');
      expect(html).toBe(outline);
    }
  });

  test('duotone is the outline over the back layer at 18%', () => {
    const html = renderToStaticMarkup(<Icon name="folder" variant="duotone" />);
    expect(html).toContain('fill-opacity="0.18"');
    expect(html).toContain('stroke-width="1.5"');
  });

  test('glyph cuts its marks through a mask, so the cut is transparent', () => {
    // The board's first draft painted the cuts in the panel colour, which made a
    // glyph correct on exactly one background. A mask is a hole.
    const html = renderToStaticMarkup(<Icon name="terminal" variant="glyph" />);
    expect(html).toMatch(/<mask id="lody-icon-[a-zA-Z0-9_-]+"/);
    expect(html).toMatch(/mask="url\(#lody-icon-[a-zA-Z0-9_-]+\)"/);
    expect(html).toContain('stroke="black"');
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain('fill-opacity');
  });

  test('a glyph with nothing to cut is a plain fill', () => {
    const html = renderToStaticMarkup(<Icon name="play" variant="glyph" />);
    expect(html).not.toContain('<mask');
    expect(html).toContain('fill="currentColor"');
  });

  test('two glyphs on one page do not share a mask, and the name is in the id', () => {
    const html = renderToStaticMarkup(
      <>
        <Icon name="terminal" variant="glyph" />
        <Icon name="folder" variant="glyph" />
      </>
    );
    const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    // Two React trees on one page restart `useId`; with the name in the id the
    // mask one glyph then resolves is, at worst, an identical one.
    expect(ids[0]).toMatch(/^lody-icon-terminal-/);
    expect(ids[1]).toMatch(/^lody-icon-folder-/);
  });

  test('a glyph keeps the strokes outside its mass', () => {
    // The agent's antenna and ears, the bell's nub: cutting them would change
    // the silhouette, and the silhouette is what a glyph is for.
    const html = renderToStaticMarkup(<Icon name="agent" variant="glyph" />);
    expect(html).toContain(`d="${ICONS.agent.layers!.outer}"`);
    expect(html).toContain('stroke-width="2.5"');
  });

  test('bulk is two fills and no outline', () => {
    const html = renderToStaticMarkup(<Icon name="model" variant="bulk" />);
    expect(html).toContain('fill-opacity="0.35"');
    expect(html).toContain('fill-opacity="0.55"');
    expect(html).toContain(`d="${ICONS.model.layers!.front}" fill="currentColor"`);
    expect(html).not.toContain(`d="${ICONS.model.layers!.mass}" stroke`);
    // The cube's own edge line is not drawn in bulk: the faces' opacities are
    // the edge, and a 100% stroke over a 35% face was the stick that stuck out.
    expect(html).not.toContain(ICONS.model.layers!.detail!);
  });

  test('a named icon is the same element with its name fixed', () => {
    const Made = createIcon('branch', 'BranchIcon');
    expect(Made.displayName).toBe('BranchIcon');
    expect(renderToStaticMarkup(<SidebarIcon variant="bulk" />)).toBe(
      renderToStaticMarkup(<Icon name="sidebar" variant="bulk" />)
    );
  });

  test('every icon renders in every variant', () => {
    for (const name of ICON_NAMES as IconName[]) {
      for (const variant of VARIANTS) {
        expect(renderToStaticMarkup(<Icon name={name} variant={variant} />)).toContain('<svg');
      }
    }
  });
});

describe('a stateful icon', () => {
  test('states where it is as one number the transition can follow', () => {
    const open = renderToStaticMarkup(<SidebarToggleIcon collapsed={false} />);
    const closed = renderToStaticMarkup(<SidebarToggleIcon collapsed />);
    expect(open).toContain('--lody-icon-t:0');
    expect(closed).toContain('--lody-icon-t:1');
    expect(open).toContain('data-t="0"');
    // Both states are the same markup: nothing is added or removed, so the way
    // between them is interpolation and not a swap.
    expect(open.replace('--lody-icon-t:0', '').replace('data-t="0"', '')).toBe(
      closed.replace('--lody-icon-t:1', '').replace('data-t="1"', '')
    );
  });

  test('is decoration unless titled, like the static set', () => {
    expect(renderToStaticMarkup(<ChevronToggleIcon open />)).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<ChevronToggleIcon open title="Collapse" />)).toContain(
      'role="img"'
    );
  });

  test('the bell that rings is the bell the set draws', () => {
    // A stateful icon that restates a path drifts from the static one the first
    // time the set is redrawn — which is how the collapsed sidebar became two
    // different pictures. Where a state moves the whole drawing, it reads it.
    const mark = ICONS.bell.marks[0];
    expect('path' in mark).toBe(true);
    const outline = (mark as { path: string }).path;
    expect(renderToStaticMarkup(<BellRingIcon ringing={false} />)).toContain(`d="${outline}"`);
  });

  test('a frame can be pinned between the states', () => {
    const html = renderToStaticMarkup(
      <IconFrame t={0.5}>
        <path d="M7 10l5 5 5-5" />
      </IconFrame>
    );
    expect(html).toContain('--lody-icon-t:0.5');
  });
});
