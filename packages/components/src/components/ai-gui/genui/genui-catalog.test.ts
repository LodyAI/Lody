import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { GENUI_CATALOG, resolveIcon } from './genui-catalog';

describe('resolveIcon', () => {
  it('resolves current kebab-case names directly', () => {
    expect(resolveIcon('circle-x')).toBeTruthy();
    expect(resolveIcon('check')).toBeTruthy();
  });

  it('falls back to rotated segments for dropped lucide aliases', () => {
    expect(resolveIcon('x-circle')).toBe(resolveIcon('circle-x'));
  });

  it('returns undefined for unknown names', () => {
    expect(resolveIcon('not-an-icon')).toBeUndefined();
    expect(resolveIcon('zzz')).toBeUndefined();
  });
});

describe('svg catalog family', () => {
  const render = (tag: string, props: Record<string, unknown>) =>
    GENUI_CATALOG[tag]?.(props) as ReactElement<Record<string, unknown>>;

  it('renders whitelisted geometry and camelizes kebab attributes', () => {
    const el = render('rect', {
      x: 3,
      width: '334',
      'stroke-width': 2,
      fill: 'currentColor',
    });
    expect(el.type).toBe('rect');
    expect(el.props).toMatchObject({
      x: 3,
      width: '334',
      strokeWidth: 2,
      fill: 'currentColor',
    });
  });

  it('drops every attribute outside the whitelist', () => {
    const el = render('svg', {
      viewBox: '0 0 10 10',
      href: 'javascript:alert(1)',
      style: { position: 'fixed' },
      class: 'injected',
      onClick: () => 1,
      'data-x': '1',
    });
    expect(Object.keys(el.props).sort()).toEqual(['children', 'className', 'viewBox']);
  });

  it('keeps aria attributes in kebab case on the svg root', () => {
    const el = render('svg', { 'aria-label': 'diagram', role: 'img' });
    expect(el.props).toMatchObject({ 'aria-label': 'diagram', role: 'img' });
  });

  it('exposes svg text under the namespaced tag, never html/script escapes', () => {
    expect(render('svg:text', { x: 1, y: 2, children: 'label' }).type).toBe('text');
    for (const tag of ['image', 'foreignObject', 'use', 'script', 'animate', 'a']) {
      expect(GENUI_CATALOG[tag]).toBeUndefined();
    }
  });
});

describe('Diagram', () => {
  const render = (props: Record<string, unknown>) =>
    GENUI_CATALOG.Diagram?.(props) as ReactElement<Record<string, unknown>>;

  type AnyEl = ReactElement<Record<string, unknown>>;
  const findAll = (el: ReactElement, type: string): AnyEl[] => {
    const out: AnyEl[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const element = node as AnyEl;
      if (element.type === type) out.push(element);
      walk(element.props?.children);
    };
    walk(el);
    return out;
  };

  const layers = [
    { label: 'Clients', items: [{ id: 'desk', title: 'Desktop' }, { id: 'web', title: 'Web' }] },
    {
      label: 'Daemon',
      items: [
        { id: 'core', title: 'Core', subtitle: 'runtime' },
        { id: 'ext', title: 'Extensions' },
      ],
    },
  ];

  it('renders an svg root sized to its layers', () => {
    const el = render({ layers, edges: [] });
    expect(el.type).toBe('svg');
    expect(el.props.viewBox).toMatch(/^0 0 560 \d+$/);
  });

  it('computes geometry for every item — no model coordinates needed', () => {
    const el = render({ layers, edges: [] });
    const rects = findAll(el, 'rect');
    const texts = findAll(el, 'text');
    // 2 layer bands + 4 item boxes.
    expect(rects.length).toBe(6);
    // Item titles render; a subtitle adds one more text node.
    expect(texts.map((t) => t.props.children)).toEqual(
      expect.arrayContaining(['Desktop', 'Web', 'Core', 'Extensions', 'runtime'])
    );
    // Two items in a layer share the band: distinct x, same y.
    const itemRects = rects.slice(2);
    expect(new Set(itemRects.map((r) => r.props.y)).size).toBeLessThanOrEqual(2);
  });

  it('draws an edge between the referenced item ids', () => {
    const el = render({ layers, edges: [{ from: 'web', to: 'core', label: 'RPC' }] });
    const lines = findAll(el, 'line');
    expect(lines.length).toBe(1);
    const labels = findAll(el, 'text').map((t) => t.props.children);
    expect(labels).toContain('RPC');
  });

  it('routes a cross-layer edge through a side gutter as a path', () => {
    const el = render({
      layers: [
        { items: [{ id: 'x', title: 'X' }] },
        { items: [{ id: 'mid', title: 'Mid' }] },
        { items: [{ id: 'y', title: 'Y' }] },
      ],
      edges: [{ from: 'x', to: 'y', label: 'skip' }],
    });
    // A multi-layer edge becomes an orthogonal path, not a band-crossing line.
    const paths = findAll(el, 'path');
    expect(paths.length).toBe(1);
    expect(String(paths[0].props.d)).toContain('L');
    expect(findAll(el, 'line').length).toBe(0);
  });

  it('skips edges that reference missing ids instead of throwing', () => {
    const el = render({ layers, edges: [{ from: 'web', to: 'ghost' }] });
    expect(findAll(el, 'line').length).toBe(0);
    expect(el.type).toBe('svg');
  });

  it('ignores malformed layers/edges gracefully', () => {
    const el = render({ layers: 'nope', edges: 42 });
    expect(el.type).toBe('svg');
    expect(findAll(el, 'rect').length).toBe(0);
  });
});
