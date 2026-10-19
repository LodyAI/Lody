// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  applyMermaidColors,
  renderMarkdownMermaidSvg,
  resolveMermaidColors,
  withMermaidColors,
} from '../src/components/ai-gui/markdown-mermaid';

const rootSvgTag = (svg: string) => svg.slice(0, svg.indexOf('>') + 1);

describe('markdown mermaid rendering', () => {
  it('renders a flowchart that takes its colors from the surrounding theme', async () => {
    const svg = await renderMarkdownMermaidSvg(['graph TD', '  A[Start]-->B[Done]'].join('\n'));
    const root = rootSvgTag(svg);

    expect(root).toContain('pele-flowchart');
    expect(root).toContain('var(--pele-fg');
    // No literal palette is baked in, so the block's theme variables apply.
    expect(root).not.toMatch(/--pele-fg:/);
    expect(svg).toContain('Start');
  });

  it('renders diagram types the previous renderer showed as source', async () => {
    const pie = await renderMarkdownMermaidSvg(
      ['pie title Pets', '  "Dogs" : 40', '  "Cats" : 60'].join('\n')
    );
    const gantt = await renderMarkdownMermaidSvg(
      ['gantt', '  title Plan', '  section Build', '  Ship :a1, 2026-01-01, 3d'].join('\n')
    );

    expect(rootSvgTag(pie)).toContain('pele-pie');
    expect(pie.match(/class="pele-slice"/g)).toHaveLength(2);
    expect(pie).toContain('var(--pele-series-1');
    expect(rootSvgTag(gantt)).toContain('pele-gantt');
    expect(gantt).toContain('Ship');
  });

  it('drops diagram links and remote images', async () => {
    const svg = await renderMarkdownMermaidSvg(
      [
        'graph TD',
        '  A-->B',
        '  click A "https://example.com/track"',
        '  C@{ img: "https://example.com/pixel.png", label: "C" }',
      ].join('\n')
    );

    expect(svg).not.toContain('example.com');
  });

  it('falls back to a themed multi-line code block for unsupported diagram types', async () => {
    const svg = await renderMarkdownMermaidSvg(
      ['zenuml', '  title Order', '  Alice->Bob: hello'].join('\n')
    );

    expect(svg).not.toContain('Diagram unavailable');
    // One tspan per source line, so the fallback actually renders multi-line.
    expect(svg.match(/<tspan/g)).toHaveLength(3);
    expect(svg).toContain('zenuml');
    expect(svg).toContain('fill="var(--pele-surface');
    expect(svg).toContain('fill="var(--pele-fg');
  });

  it('falls back to the source listing on a syntax error', async () => {
    const svg = await renderMarkdownMermaidSvg(['graph TD', '  A-->'].join('\n'));

    expect(svg.match(/<tspan/g)).toHaveLength(2);
    expect(svg).toContain('A--&gt;');
  });

  it('escapes markup in the fallback source listing', async () => {
    const svg = await renderMarkdownMermaidSvg('zenuml <script>alert(1)</script>');

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

describe('mermaid colors for copies that leave the block', () => {
  const themedHost = () => {
    const host = document.createElement('div');
    host.style.setProperty('--pele-fg', 'rgb(1, 2, 3)');
    host.style.setProperty('--pele-bg', 'rgb(250, 250, 250)');
    document.body.append(host);
    return host;
  };

  it('bakes the colors in effect into downloaded markup', async () => {
    const host = themedHost();
    const svg = await renderMarkdownMermaidSvg(['graph TD', '  A-->B'].join('\n'));

    const file = withMermaidColors(svg, resolveMermaidColors(host));
    const root = rootSvgTag(file);

    expect(root).toContain('--pele-fg:rgb(1, 2, 3)');
    expect(root).toContain('--pele-bg:rgb(250, 250, 250)');
    // Pele's own declarations still follow, so they read the baked values.
    expect(root).toContain('var(--pele-fg');
    host.remove();
  });

  it('adds a style attribute to markup that has none', () => {
    const host = themedHost();

    const file = withMermaidColors(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1"></svg>',
      resolveMermaidColors(host)
    );

    expect(rootSvgTag(file)).toContain(
      'style="--pele-bg:rgb(250, 250, 250);--pele-fg:rgb(1, 2, 3)"'
    );
    host.remove();
  });

  it('declares the colors on a detached clone', () => {
    const host = themedHost();
    const clone = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    applyMermaidColors(clone, resolveMermaidColors(host));

    expect(clone.style.getPropertyValue('--pele-fg')).toBe('rgb(1, 2, 3)');
    host.remove();
  });
});
