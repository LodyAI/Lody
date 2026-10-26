# Settings surfaces

Binding guidelines live in [AGENTS.md](AGENTS.md).

## Usage range transitions

`usage-calendar-visualization.tsx` keeps a positioned view frame across hourly and
calendar ranges so exiting charts retain their measured coordinates. The hourly
ring grid changes inside that frame. Whole-view opacity fades handle the handoff;
calendar cells render together without individual reveal animations. The
[transition decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-21-usage-range-transition.md)
records the misplaced-chart reproduction and browser coverage.

## Machine connection marks

`workspace-machine-accordion.tsx` renders the connection mark for collapsed and
expanded machine cards. An online machine keeps its solid green centre while
its halo expands and contracts at a constant speed over 2.8 seconds, using linear
CSS transform and opacity animation. Each direction takes 1.4 seconds.
Offline machines keep a static gray dot. Reduced motion keeps the online halo
static. Motion follows the existing `isOnline` value and adds no presence polling.

The [OnlineStatusMotion story](../../stories/DevicesDesktopLayout.stories.tsx)
uses the real machine card with a controlled online/offline value for inspection.

## Wallpaper

`wallpaper-settings.tsx` adds a device-local image and live preview to desktop
Appearance. Transparency (0–100%), blur (0–24px) and vignette (0–80%) apply only
to the background; Reset adjustments preserves the image and Remove clears it.
The desktop new-conversation page renders the same `WallpaperBackdrop`, fading
from top to bottom. Existing composer/card materials and shadows stay theme-owned.

`lib/wallpaper.ts` decodes PNG/JPEG/WebP files up to 20 MB, scales their longest
edge to at most 1920px and encodes a bounded WebP copy. `atoms/wallpaper.ts`
persists it with the adjustments under `lody-appearance-wallpaper`, updates other
windows through storage events, and keeps the previous selection if saving fails.
No source path, remote image URL or workspace document is involved. This preference
survives cache clearing. Mobile and existing conversations retain their backgrounds.
