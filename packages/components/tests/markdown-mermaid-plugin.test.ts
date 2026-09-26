import { describe, expect, it, vi } from 'vitest';

vi.mock('beautiful-mermaid', () => ({
  renderMermaidSVGAsync: async (source: string) => {
    if (!source.includes('A-->B')) {
      throw new Error(`Invalid mermaid header: "${source.split('\n')[0]}"`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" data-diagram="flowchart"></svg>`;
  },
}));

vi.mock('mermaid', () => {
  throw new Error('mermaid.js must not load after the renderer unifies on beautiful-mermaid');
});

const { createMarkdownMermaidConfig, renderMarkdownMermaidSvg } =
  await import('../src/components/ai-gui/markdown-mermaid');

const relativeLuminance = (hex: string): number => {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

describe('markdown mermaid rendering', () => {
  it('renders a flowchart through beautiful-mermaid', async () => {
    const svg = await renderMarkdownMermaidSvg(['graph TD', '  A-->B'].join('\n'), 'dark');

    expect(svg).toContain('data-diagram="flowchart"');
  });

  it('keeps dark-mode mermaid colors readable', () => {
    const lightConfig = createMarkdownMermaidConfig('light');
    const darkConfig = createMarkdownMermaidConfig('dark');

    expect(lightConfig.theme).toBe('base');
    expect(darkConfig.theme).toBe('base');
    expect(darkConfig.darkMode).toBe(true);
    // Dark diagram text is readable but no brighter than the app's dark text
    // ceiling (#D5D5D5-level luminance), never near-white.
    const variables = darkConfig.themeVariables as Record<string, string>;
    for (const name of [
      'primaryTextColor',
      'textColor',
      'titleColor',
      'actorTextColor',
      'signalTextColor',
      'noteTextColor',
    ]) {
      const luminance = relativeLuminance(variables[name]!);
      expect({ name, readable: luminance > 0.5, capped: luminance <= 0.666 }).toEqual({
        name,
        readable: true,
        capped: true,
      });
    }
    expect(darkConfig.themeVariables).not.toBe(lightConfig.themeVariables);
  });

  it('falls back to a themed multi-line code block for unsupported diagram types', async () => {
    const svg = await renderMarkdownMermaidSvg(
      ['pie title Pets', '  "Dogs" : 40', '  "Cats" : 60'].join('\n'),
      'dark'
    );

    expect(svg).not.toContain('Diagram unavailable');
    // One tspan per source line, so the fallback actually renders multi-line.
    expect(svg.match(/<tspan/g)).toHaveLength(3);
    expect(svg).toContain('pie title Pets');
    // Dark theme surface/text colors, not the old light amber panel.
    expect(svg).toContain('fill="#111827"');
    expect(svg).toContain('fill="#cbd5e1"');
  });

  it('escapes markup in the fallback source listing', async () => {
    const svg = await renderMarkdownMermaidSvg('pie title <script>alert(1)</script>', 'light');

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});
