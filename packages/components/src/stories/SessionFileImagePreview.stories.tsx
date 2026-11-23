import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { SessionFileImagePreview } from '@/components/sessions/session-file-image-preview';
const storyLayout = stylex.create({
  frame: {
    height: '26rem',
    width: '100%',
    maxWidth: '46rem',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border) / 1)',
    backgroundColor: 'hsl(var(--background) / 1)',
  },
});

/**
 * The Code Collab file preview for image files. Both the desktop side panel and
 * the mobile file drawer mount this exact component. Click/tap the fitted image
 * to open the shared full-screen `ZoomableImageViewer` — pinch-to-zoom,
 * double-tap, drag-to-pan, and the top-right close button live there, so this
 * story is also the way to exercise them without a real Code Collab session.
 */
const meta = {
  title: 'Sessions/SessionFileImagePreview',
  component: SessionFileImagePreview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SessionFileImagePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 320×200 checkerboard PNG — small enough to inline, large enough to zoom. */
const CHECKER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAADYElEQVR42u3csQ2AMBAEQXfiEmmWVsjdAw5edxpEPtK9NvXaz/v7/y4+Lpd77y5Dc7kCNjSXK2AulytgLlfAhuZyBWxoLlfAXC5XwFyugA3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kCdmAuV8BcLlfAXG5JwMbicnNdAXO5AjY0lytgLpcrYC5XwIbmcgVsaC5XwFwuV8BcroANzeUKmMvlCpjLFbChuVwBG5rLFTCXyxUwlytgQ3O5AnZgLlfAXC5XwFxuS8DG4nK9SmloLlfAXC5XwFyugA3N5QrY0FyugLlcroC5XAEbmssVMJfLFTCXK2BDc7kCNjSXK2AulytgLlfAhuZyBezAXK6AuVyugLlcARuay50O2Fhcbq4rYC5XwIbmcgXM5XIFzOUK2NBcroANzeUKmMvlCpjLFbChuVwBc7lcAXO5AjY0lytgQ3O5AuZyuQLmcgVsaC5XwA7M5QqYy+UKmMttCdhYXK5XKQ3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kC5nK5AuZyBWxoLlfAhuZyBczlcgXM5QrY0FyugB2YyxUwl8sVMJcrYENzudMBG4vLzXUFzOUK2NBcroC5XK6AuVwBG5rLFbChuVwBc7lcAXO5AjY0lytgLpcrYC5XwIbmcgVsaC5XwFwuV8BcroANzeUK2IG5XAFzuVwBc7ktARuLy/UqpaG5XAFzuVwBc7kCNjSXK2BDc7kC5nK5AuZyBWxoLlfAXC5XwFyugA3N5QrY0FyugLlcroC5XAEbmssVsANzuQLmcrkC5nIFbGgudzpgY3G5ua6AuVwBG5rLFTCXyxUwlytgQ3O5AjY0lytgLpcrYC5XwIbmcgXM5XIFzOUK2NBcroANzeUKmMvlCpjLFbChuVwBOzCXK2AulytgLrclYGNxuV6lNDSXK2AulytgLlfAhuZyBWxoLlfAXC5XwFyugA3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kCdmAuV8BcLlfAXK6ADc3lTgdsLC431xUwlytgQ3O5AuZyuQLmcgVsaC5XwIbmcgXM5XIFzOUK2NBcroC5XK6AuVwBG5rLFbChuVwBc7lcAXO5AjY0lytgB+ZyBczlcgXM5Za4B+mr3B4lnmDrAAAAAElFTkSuQmCC';

const decodeBase64 = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200">
  <rect width="320" height="200" fill="#0f172a" />
  <circle cx="110" cy="100" r="60" fill="#1f6fd4" />
  <text x="200" y="106" fill="#f8fafc" font-family="sans-serif" font-size="22">preview.svg</text>
</svg>`;

/* The component fills its container, so every story gives it a bounded frame —
   the real callers are a side panel and a full-screen mobile drawer. */
const frame = (content: React.ReactNode) => (
  <div {...stylex.props(storyLayout.frame)}>{content}</div>
);

export const RasterImage: Story = {
  args: { path: 'assets/checker.png', bytes: decodeBase64(CHECKER_PNG_BASE64) },
  render: (args) => frame(<SessionFileImagePreview {...args} />),
};

/** SVG arrives as text (it is classified as a text file), not as bytes. */
export const SvgImage: Story = {
  args: { path: 'assets/preview.svg', svgText: SAMPLE_SVG },
  render: (args) => frame(<SessionFileImagePreview {...args} />),
};

/** Not a previewable image → renders nothing so callers can fall back. */
export const NotAnImage: Story = {
  args: { path: 'src/index.ts', svgText: 'export const a = 1;' },
  render: (args) => frame(<SessionFileImagePreview {...args} />),
};
