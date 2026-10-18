import { describe, expect, it } from 'vitest';

import {
  markdownMermaidPalette,
  renderMarkdownMermaidSvg,
} from '../src/components/ai-gui/markdown-mermaid';

const relativeLuminance = (hex: string): number => {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const rootSvgTag = (svg: string) => svg.slice(0, svg.indexOf('>') + 1);

describe('markdown mermaid rendering', () => {
  it('renders a flowchart with the theme palette declared on the root svg', async () => {
    const svg = await renderMarkdownMermaidSvg(
      ['graph TD', '  A[Start]-->B[Done]'].join('\n'),
      'dark'
    );
    const root = rootSvgTag(svg);

    expect(root).toContain('pele-flowchart');
    // Declared on the svg itself, so a downloaded or full-screen copy keeps the colors.
    expect(root).toContain('--pele-bg:#0b1120');
    expect(root).toContain('--pele-fg:#cbd5e1');
    expect(svg).toContain('Start');
  });

  it('renders diagram types the previous renderer showed as source', async () => {
    const pie = await renderMarkdownMermaidSvg(
      ['pie title Pets', '  "Dogs" : 40', '  "Cats" : 60'].join('\n'),
      'light'
    );
    const gantt = await renderMarkdownMermaidSvg(
      ['gantt', '  title Plan', '  section Build', '  Ship :a1, 2026-01-01, 3d'].join('\n'),
      'light'
    );

    expect(rootSvgTag(pie)).toContain('pele-pie');
    expect(rootSvgTag(pie)).toContain('--pele-fg:#0f172a');
    expect(pie.match(/class="pele-slice"/g)).toHaveLength(2);
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
      ].join('\n'),
      'light'
    );

    expect(svg).not.toContain('example.com');
  });

  it('keeps dark-mode diagram text readable but under the brightness ceiling', () => {
    const light = markdownMermaidPalette('light');
    const dark = markdownMermaidPalette('dark');

    // Dark diagram text is readable but no brighter than the app's dark text
    // ceiling (#D5D5D5-level luminance), never near-white.
    for (const name of ['fg', 'muted'] as const) {
      const luminance = relativeLuminance(dark[name]);
      expect({ name, readable: luminance > 0.3, capped: luminance <= 0.666 }).toEqual({
        name,
        readable: true,
        capped: true,
      });
    }
    expect(dark).not.toEqual(light);
  });

  it('falls back to a themed multi-line code block for unsupported diagram types', async () => {
    const svg = await renderMarkdownMermaidSvg(
      ['zenuml', '  title Order', '  Alice->Bob: hello'].join('\n'),
      'dark'
    );

    expect(svg).not.toContain('Diagram unavailable');
    // One tspan per source line, so the fallback actually renders multi-line.
    expect(svg.match(/<tspan/g)).toHaveLength(3);
    expect(svg).toContain('zenuml');
    expect(svg).toContain('fill="#111827"');
    expect(svg).toContain('fill="#cbd5e1"');
  });

  it('falls back to the source listing on a syntax error', async () => {
    const svg = await renderMarkdownMermaidSvg(['graph TD', '  A-->'].join('\n'), 'light');

    expect(svg.match(/<tspan/g)).toHaveLength(2);
    expect(svg).toContain('A--&gt;');
  });

  it('escapes markup in the fallback source listing', async () => {
    const svg = await renderMarkdownMermaidSvg('zenuml <script>alert(1)</script>', 'light');

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});
