# Stabilize image and Mermaid viewer gestures

Status: implemented
Translation: current

[中文](2026-09-27-mermaid-and-image-viewer-gestures.zh.md)

## Abstract

Image taps in the shared lightbox could close the surface while the originating
thumbnail was still handling the same click, and vertical pulls could enter the
lightbox dismissal animation during a pan. Large Mermaid diagrams also had no
touch pinch path in the full-screen viewer, while centred overflow could hide an
edge. The lightbox now leaves photo taps and pull-to-dismiss disabled, and the
Mermaid viewer owns touch panning and two-finger zoom with safe overflow alignment.

## Decision

`react-photo-view` remains the shared image viewer. `photoClosable={false}` keeps
the image as a pan/zoom surface; the toolbar and backdrop remain exits, while
`pullClosable={false}` prevents a vertical pan from becoming dismissal motion.

The full-screen Mermaid surface uses Pointer Events with `touch-action: none`
only in that surface. One touch updates scroll offsets, and two touches zoom
around their centre while following centre movement. The inline preview keeps
native touch behavior and still opens the viewer on a tap. The viewer's wrapper
uses safe centre alignment so a fitting diagram is centred but an oversized one
starts at a reachable edge.

The earlier alternative of leaving touch to browser scrolling was rejected for
the full-screen viewer because it cannot provide pinch zoom; taking touch input
from the inline message was rejected because it would steal conversation scroll.

## Verification

`packages/components/tests/markdown-mermaid-fullscreen.test.tsx` passes all 34
tests, including one-finger pan, two-finger pinch, trackpad pinch, and backdrop
protection. `packages/components/tests/image-preview-context-menu.test.tsx`
passes all 9 tests, including a photo tap that must not close the viewer, and
targeted Oxlint reports no findings. The checkout has no installed package
manager or local dependencies; using a temporary dependency link allowed the
focused tests to run. A full `tsgo` check remains blocked by unrelated missing
Electron/ACP workspace packages, and the repository docs check retains its
pre-existing broken links outside these files.
