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

describe('Mock', () => {
  const render = (props: Record<string, unknown>) =>
    GENUI_CATALOG.Mock?.(props) as ReactElement<Record<string, unknown>>;

  it('is registered alongside the namespaced layout tags', () => {
    for (const tag of ['Mock:Col', 'Mock:Row', 'Mock:Cell', 'Mock:Box']) {
      expect(GENUI_CATALOG[tag]).toBeTruthy();
    }
  });

  it('carries the layout props the renderer consumes', () => {
    const el = render({ w: 160, h: 132, children: 'x' });
    expect(el.props.w).toBe(160);
    expect(el.props.h).toBe(132);
    expect(el.props.children).toBe('x');
  });

  it('lays out a nested Col/Row tree into svg rects and clipped labels', () => {
    const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
    const { createElement } = require('react') as typeof import('react');
    const tree = createElement(
      GENUI_CATALOG.Mock as never,
      { w: 100, h: 60 } as never,
      createElement(
        GENUI_CATALOG['Mock:Col'] as never,
        null,
        createElement(GENUI_CATALOG['Mock:Cell'] as never, { h: 16, tone: 'deep' } as never),
        createElement(
          GENUI_CATALOG['Mock:Row'] as never,
          null,
          createElement(GENUI_CATALOG['Mock:Cell'] as never, { w: 30, tone: 'band' } as never),
          createElement(
            GENUI_CATALOG['Mock:Box'] as never,
            { tone: 'faint', label: 'Main', sub: 'view' } as never
          )
        )
      )
    );
    const svg = renderToStaticMarkup(tree);
    expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(svg).toContain('>Main<');
    expect(svg).toContain('clip-path');
  });

  it('splits the free space by flex and honours fixed main-axis sizes', () => {
    const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
    const { createElement } = require('react') as typeof import('react');
    const tree = createElement(
      GENUI_CATALOG.Mock as never,
      { w: 90, h: 40, pad: 0, gap: 0 } as never,
      createElement(
        GENUI_CATALOG['Mock:Row'] as never,
        { gap: 0 } as never,
        createElement(GENUI_CATALOG['Mock:Cell'] as never, { w: 30 } as never),
        createElement(GENUI_CATALOG['Mock:Cell'] as never, { flex: 1 } as never),
        createElement(GENUI_CATALOG['Mock:Cell'] as never, { flex: 2 } as never)
      )
    );
    const svg = renderToStaticMarkup(tree);
    const widths = [
      ...svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)"[^>]*fill-opacity/g),
    ].map((m) => parseFloat(m[1]));
    expect(widths).toEqual([30, 19.5, 38.5]);
  });
});
