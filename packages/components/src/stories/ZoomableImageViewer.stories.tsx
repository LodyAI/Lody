import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ZoomableImageViewer } from '@/components/shared/zoomable-image-viewer';
import { Button } from '@lody/ui/button';

/**
 * The one full-screen image viewer in the app. Chat image blocks
 * (`ai-gui/view.tsx`) and the Code Collab file preview
 * (`sessions/session-file-image-preview.tsx`) both mount it, so the gestures
 * stay identical: pinch-to-zoom, double-tap zoom, wheel zoom, drag-to-pan, and
 * a close button in the top-right corner.
 */
const meta = {
  title: 'Shared/ZoomableImageViewer',
  component: ZoomableImageViewer,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ZoomableImageViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

// `width`/`height` are load-bearing, not decoration: the viewer sizes a photo
// from its INTRINSIC dimensions, and a viewBox-only SVG reports the 300x150
// default — which would make every story exercise the small-image path.
const svgDataUrl = (label: string, background: string, accent: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">` +
      `<rect width="1200" height="800" fill="${background}" />` +
      `<circle cx="420" cy="400" r="220" fill="${accent}" />` +
      `<text x="700" y="415" fill="#f8fafc" font-family="sans-serif" font-size="72">${label}</text>` +
      `</svg>`
  )}`;

const tallSvgDataUrl = (label: string, background: string, accent: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1179" height="2556" viewBox="0 0 1179 2556">` +
      `<rect width="1179" height="2556" fill="${background}" />` +
      `<rect x="80" y="200" width="1019" height="700" rx="48" fill="${accent}" />` +
      `<text x="80" y="1200" fill="#f8fafc" font-family="sans-serif" font-size="96">${label}</text>` +
      `</svg>`
  )}`;

const SINGLE_IMAGE = [{ key: 'shot-1', src: svgDataUrl('screenshot', '#0f172a', '#1f6fd4') }];

const PHONE_SCREENSHOT = [
  { key: 'phone-1', src: tallSvgDataUrl('phone screenshot', '#f8fafc', '#1f6fd4') },
];

const GALLERY_IMAGES = [
  { key: 'shot-1', src: svgDataUrl('one', '#0f172a', '#1f6fd4') },
  { key: 'shot-2', src: svgDataUrl('two', '#14532d', '#22c55e') },
  { key: 'shot-3', src: svgDataUrl('three', '#3b0764', '#a855f7') },
];

function ViewerHarness({ images }: { images: { key: string; src: string }[] }) {
  const [index, setIndex] = useState<number | null>(0);

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-muted/20">
      <p className="text-sm text-muted-foreground">
        Drag to pan, scroll or double-click to zoom, close from the top-right button.
      </p>
      <Button onClick={() => setIndex(0)} disabled={index !== null}>
        Open viewer
      </Button>
      <ZoomableImageViewer
        open={index !== null}
        onClose={() => setIndex(null)}
        images={images}
        index={index ?? 0}
        onIndexChange={setIndex}
      />
    </div>
  );
}

/** One image: no arrows, close button only. Matches the file preview. */
export const SingleImage: Story = {
  args: { open: true, onClose: () => {}, images: SINGLE_IMAGE, index: 0 },
  render: () => <ViewerHarness images={SINGLE_IMAGE} />,
};

/**
 * A phone screenshot — the aspect ratio that shows whether the desktop viewer
 * frames the photo or blows it up edge to edge against the window.
 */
export const TallScreenshot: Story = {
  args: { open: true, onClose: () => {}, images: PHONE_SCREENSHOT, index: 0 },
  render: () => <ViewerHarness images={PHONE_SCREENSHOT} />,
};

/** Multiple images: the chat gallery case, with prev/next arrows and a counter. */
export const Gallery: Story = {
  args: { open: true, onClose: () => {}, images: GALLERY_IMAGES, index: 0 },
  render: () => <ViewerHarness images={GALLERY_IMAGES} />,
};
