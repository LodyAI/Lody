/**
 * The boot shell: the frame a window paints before the renderer bundle has
 * downloaded, executed and committed React.
 *
 * Everything React draws — loading gates, the lazily loaded workspace layout —
 * exists only after the first commit, so until then `#root` is an empty canvas.
 * `vite-boot-shell.ts` inlines this module's markup and stylesheet, plus the
 * script from `boot-shell-script.ts`, into the host `index.html`, so the frame
 * is part of the document's first paint.
 * `components/boot-shell.tsx` renders the same markup from React for the gates
 * that follow, so the static frame and React's first frames are identical and
 * the only visible change is the real layout arriving.
 *
 * This is plain CSS rather than StyleX on purpose: it has to style a document
 * that no bundle has touched yet, so it may not depend on product CSS, theme
 * variables (`applyVSCodeThemeCssVariables` writes those from JS) or fonts.
 * The colours are therefore literal copies of the bundled Lody Light and Vesper
 * values; `tests/boot-shell.test.tsx` fails when a theme changes under them. For
 * the same reason the mark is a data URL (`boot-shell-mark.ts`), so the first
 * paint needs no image request.
 */

import { BOOT_SHELL_MARK_DATA_URL } from './boot-shell-mark';
import { BOOT_SHELL_SIDEBAR_WIDTH } from './boot-shell-script';

/** HSL channels, in the `--background` notation `createThemeCssVariables` emits. */
export const BOOT_SHELL_COLORS = {
  light: {
    canvas: '0 0% 97.6%',
    sidebar: '240 6.7% 94.1%',
    sidebarBorder: '221.5 13.7% 81.4%',
    status: '220 8.9% 46.1%',
  },
  dark: {
    canvas: '220 7.3% 8%',
    sidebar: '225 7.4% 10.6%',
    sidebarBorder: '220 6.5% 18%',
    status: '214.3 3.7% 62.5%',
  },
} as const;

/** Rendered size of the mark, in CSS pixels. */
export const BOOT_SHELL_MARK_SIZE = 48;

/**
 * Animation delays are measured from navigation start, not from when an
 * element was created: `--lody-boot-elapsed` carries each copy's creation time,
 * so when React replaces the static frame with its own copy the mark keeps its
 * phase instead of restarting. Gate copy also waits 400ms after its own
 * mount, so a gate that passes in a frame never flashes its text.
 */
const hsl = (channels: string) => `hsl(${channels})`;
const light = BOOT_SHELL_COLORS.light;
const dark = BOOT_SHELL_COLORS.dark;

export const BOOT_SHELL_CSS = `
.lody-boot-shell{position:fixed;inset:0;display:flex;overflow:hidden;background:${hsl(light.canvas)};color:${hsl(light.status)};font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.dark .lody-boot-shell{background:${hsl(dark.canvas)};color:${hsl(dark.status)}}
.lody-boot-shell__sidebar{display:none;flex:none;box-sizing:border-box;width:var(--lody-boot-sidebar-width,${BOOT_SHELL_SIDEBAR_WIDTH.default}px);height:100%;background:${hsl(light.sidebar)};border-right:1px solid ${hsl(light.sidebarBorder)}}
.dark .lody-boot-shell__sidebar{background:${hsl(dark.sidebar)};border-right-color:${hsl(dark.sidebarBorder)}}
[data-lody-boot-sidebar] .lody-boot-shell__sidebar,.lody-boot-shell[data-sidebar=shown] .lody-boot-shell__sidebar{display:block}
.lody-boot-shell.lody-boot-shell[data-sidebar=hidden] .lody-boot-shell__sidebar{display:none}
.lody-boot-shell__main{position:relative;display:flex;flex:1;min-width:0;align-items:center;justify-content:center}
.lody-boot-shell__mark{display:block;width:${BOOT_SHELL_MARK_SIZE}px;height:${BOOT_SHELL_MARK_SIZE}px;animation:lody-boot-shell-in .24s ease-out calc(120ms - var(--lody-boot-elapsed,0ms)) both,lody-boot-shell-breathe 2.4s ease-in-out calc(1200ms - var(--lody-boot-elapsed,0ms)) infinite}
.lody-boot-shell__status{position:absolute;top:calc(50% + 40px);left:24px;right:24px;text-align:center;animation:lody-boot-shell-in .24s ease-out max(400ms,calc(900ms - var(--lody-boot-elapsed,0ms))) both}
.lody-boot-shell__status-title{font-size:13px;font-weight:500}
@keyframes lody-boot-shell-in{from{opacity:0}}
@keyframes lody-boot-shell-breathe{50%{opacity:.5}}
@media (max-width:767px){.lody-boot-shell.lody-boot-shell .lody-boot-shell__sidebar{display:none}}
@media (prefers-reduced-motion:reduce){.lody-boot-shell__mark,.lody-boot-shell__status{animation:none}}
`.trim();

export const BOOT_SHELL_MARKUP =
  '<div class="lody-boot-shell" data-lody-boot-shell="" aria-hidden="true">' +
  '<div class="lody-boot-shell__sidebar"></div>' +
  '<div class="lody-boot-shell__main">' +
  `<img class="lody-boot-shell__mark" src="${BOOT_SHELL_MARK_DATA_URL}" alt="" width="${BOOT_SHELL_MARK_SIZE}" height="${BOOT_SHELL_MARK_SIZE}" decoding="sync">` +
  '</div></div>';
