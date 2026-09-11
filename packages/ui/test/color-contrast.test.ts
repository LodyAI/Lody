import { describe, expect, test } from 'vitest';
import source from '../src/tokens/colors.stylex.ts?raw';

type Rgb = readonly [number, number, number];
type Palette = Record<string, string>;

function theme(name: 'lightTheme' | 'darkTheme'): Palette {
  const start = source.indexOf(`export const ${name} =`);
  const end = source.indexOf('\n});', start);
  expect(start, `${name} is declared`).toBeGreaterThanOrEqual(0);
  expect(end, `${name} is closed`).toBeGreaterThan(start);
  return Object.fromEntries(
    [...source.slice(start, end).matchAll(/^  (\w+): '([^']+)'/gm)].map((match) => [
      match[1],
      match[2],
    ])
  );
}

function hslToRgb(value: string): Rgb {
  const match = /^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/.exec(value);
  if (!match) throw new Error(`Contrast contract needs an opaque HSL colour, received ${value}`);
  const hue = Number(match[1]);
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;
  const channels: Rgb =
    hue < 60
      ? [chroma, secondary, 0]
      : hue < 120
        ? [secondary, chroma, 0]
        : hue < 180
          ? [0, chroma, secondary]
          : hue < 240
            ? [0, secondary, chroma]
            : hue < 300
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  return channels.map((channel) => channel + offset) as unknown as Rgb;
}

function luminance(color: Rgb): number {
  const [red, green, blue] = color.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(hslToRgb(foreground));
  const backgroundLuminance = luminance(hslToRgb(background));
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

const SURFACES = [
  'background',
  'elevatedBackground',
  'raisedBackground',
  'secondaryBackground',
  'wellBackground',
] as const;

const palettes = { light: theme('lightTheme'), dark: theme('darkTheme') };

describe('semantic colour contrast contracts', () => {
  test.each(Object.entries(palettes))('%s palette keeps normal text at 4.5:1', (_, palette) => {
    for (const foreground of ['label', 'secondaryLabel', 'hintLabel', 'accent', 'destructive']) {
      for (const background of SURFACES) {
        expect(
          contrast(palette[foreground], palette[background]),
          `${foreground} on ${background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(palette.onAccent, palette.accent), 'onAccent on accent').toBeGreaterThanOrEqual(
      4.5
    );
    expect(
      contrast(palette.onDestructive, palette.destructive),
      'onDestructive on destructive'
    ).toBeGreaterThanOrEqual(4.5);
  });

  test.each(Object.entries(palettes))(
    '%s palette keeps non-text ink and control edges at 3:1',
    (_, palette) => {
      for (const foreground of ['tertiaryLabel', 'controlEdge', 'accent', 'destructive']) {
        for (const background of SURFACES) {
          expect(
            contrast(palette[foreground], palette[background]),
            `${foreground} on ${background}`
          ).toBeGreaterThanOrEqual(3);
        }
      }
      expect(
        contrast(palette.controlEdge, palette.wellBackground),
        'controlEdge on wellBackground'
      ).toBeGreaterThanOrEqual(3);
    }
  );
});
