import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { SessionFileImagePreview } from '../components/sessions/session-file-image-preview';

const styles = stylex.create({
  canvas: {
    minHeight: '100dvh',
    padding: 16,
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  frame: {
    width: '100%',
    maxWidth: 720,
    height: 320,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border))',
  },
  constrained: { height: 96 },
  output: { display: 'block', marginTop: 16, overflowWrap: 'anywhere' },
});
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAADYElEQVR42u3csQ2AMBAEQXfiEmmWVsjdAw5edxpEPtK9NvXaz/v7/y4+Lpd77y5Dc7kCNjSXK2AulytgLlfAhuZyBWxoLlfAXC5XwFyugA3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kCdmAuV8BcLlfAXG5JwMbicnNdAXO5AjY0lytgLpcrYC5XwIbmcgVsaC5XwFwuV8BcroANzeUKmMvlCpjLFbChuVwBG5rLFTCXyxUwlytgQ3O5AnZgLlfAXC5XwFxuS8DG4nK9SmloLlfAXC5XwFyugA3N5QrY0FyugLlcroC5XAEbmssVMJfLFTCXK2BDc7kCNjSXK2AulytgLlfAhuZyBezAXK6AuVyugLlcARuay50O2Fhcbq4rYC5XwIbmcgXM5XIFzOUK2NBcroANzeUKmMvlCpjLFbChuVwBc7lcAXO5AjY0lytgQ3O5AuZyuQLmcgVsaC5XwA7M5QqYy+UKmMttCdhYXK5XKQ3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kC5nK5AuZyBWxoLlfAhuZyBczlcgXM5QrY0FyugB2YyxUwl8sVMJcrYENzudMBG4vLzXUFzOUK2NBcroC5XK6AuVwBG5rLFbChuVwBc7lcAXO5AjY0lytgLpcrYC5XwIbmcgVsaC5XwFwuV8BcroANzeUK2IG5XAFzuVwBc7ktARuLy/UqpaG5XAFzuVwBc7kCNjSXK2BDc7kC5nK5AuZyBWxoLlfAXC5XwFyugA3N5QrY0FyugLlcroC5XAEbmssVsANzuQLmcrkC5nIFbGgudzpgY3G5ua6AuVwBG5rLFTCXyxUwlytgQ3O5AjY0lytgLpcrYC5XwIbmcgXM5XIFzOUK2NBcroANzeUKmMvlCpjLFbChuVwBOzCXK2AulytgLrclYGNxuV6lNDSXK2AulytgLlfAhuZyBWxoLlfAXC5XwFyugA3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kCdmAuV8BcLlfAXK6ADc3lTgdsLC431xUwlytgQ3O5AuZyuQLmcgVsaC5XwIbmcgXM5XIFzOUK2NBcroC5XK6AuVwBG5rLFbChuVwBc7lcAXO5AjY0lytgB+ZyBczlcgXM5Za4B+mr3B4lnmDrAAAAAElFTkSuQmCC';
const bytes = Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs><pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="#18324b"/><path d="M0 0H100V100" fill="none" stroke="#83b9cd" stroke-width="4"/></pattern></defs>
  <rect width="1200" height="800" fill="url(#grid)"/><circle cx="400" cy="400" r="240" fill="#e9ae52"/><path d="M100 700L1000 100" stroke="#a3e1d4" stroke-width="32"/>
  <text x="680" y="450" font-family="sans-serif" font-size="64" fill="#fff">Synthetic image</text>
</svg>`;
const portrait = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="1280" viewBox="0 0 480 1280"><rect width="480" height="1280" fill="#1a354d"/><rect x="40" y="40" width="400" height="400" rx="40" fill="#e9ae52"/><circle cx="240" cy="900" r="160" fill="#a3e1d4"/><text x="40" y="650" font-family="sans-serif" font-size="48" fill="#fff">Synthetic tall image</text></svg>`;
const portraitUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(portrait)}`;
type Mode = 'raster' | 'svg' | 'url' | 'constrained' | 'no-source' | 'not-image';
function Fixture({ mode }: { mode: Mode }) {
  const fallback = mode === 'no-source' || mode === 'not-image';
  return (
    <div {...stylex.props(styles.canvas)} data-file-image-fixture={mode}>
      <div
        {...stylex.props(styles.frame, mode === 'constrained' && styles.constrained)}
        data-file-image-host=""
      >
        <SessionFileImagePreview
          path={
            mode === 'not-image'
              ? 'synthetic/readme.md'
              : mode === 'raster' || mode === 'no-source'
                ? 'synthetic/checker.png'
                : mode === 'url'
                  ? 'synthetic/portrait.svg'
                  : 'synthetic/grid.svg'
          }
          {...(mode === 'raster' || mode === 'not-image' ? { bytes } : {})}
          {...(mode === 'svg' || mode === 'constrained' ? { svgText: svg } : {})}
          {...(mode === 'url' ? { url: portraitUrl } : {})}
        />
      </div>
      <output {...stylex.props(styles.output)} data-file-image-fixture-result="">
        {fallback
          ? `Synthetic caller observation: ${mode}; the real preview should return null.`
          : `Synthetic source: ${mode}. Open the image to use the shared viewer.`}
      </output>
    </div>
  );
}
const meta = {
  title: 'Sessions/OwnedFileImageMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const RasterBytes: Story = { render: () => <Fixture mode="raster" /> };
export const SvgText: Story = { render: () => <Fixture mode="svg" /> };
export const UrlImage: Story = { render: () => <Fixture mode="url" /> };
export const Constrained: Story = { render: () => <Fixture mode="constrained" /> };
export const NoSource: Story = { render: () => <Fixture mode="no-source" /> };
export const NotImage: Story = { render: () => <Fixture mode="not-image" /> };
