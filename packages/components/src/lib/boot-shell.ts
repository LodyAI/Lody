/** First-paint and React boot markup. No product CSS, fonts, or providers needed. */
import { BOOT_SHELL_MARK_DATA_URL } from './boot-shell-mark';
import { BOOT_SHELL_SIDEBAR_WIDTH } from './boot-shell-script';
import { WORKSPACE_FRAME_CSS } from './workspace-frame';

/** Literal theme fallbacks are checked against the bundled themes. */
export const BOOT_SHELL_COLORS = {
  light: {
    canvas: '0 0% 97.6%',
    sidebar: '0 0% 94.1%',
    sidebarBorder: '0 0% 81.6%',
    frameBorder: '0 0% 85.5%',
    status: '0 0% 46.3%',
  },
  dark: {
    canvas: '220 7.3% 8%',
    sidebar: '225 7.4% 10.6%',
    sidebarBorder: '220 6.5% 18%',
    frameBorder: '220 6.5% 18%',
    status: '214.3 3.7% 62.5%',
  },
} as const;
export const BOOT_SHELL_MARK_SIZE = 48;
export const BOOT_SHELL_MOTION = {
  durationMs: 320,
  easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const;
const light = BOOT_SHELL_COLORS.light;
const dark = BOOT_SHELL_COLORS.dark;

/** Gate lifetime controls readiness; decorative transitions never hold input or recovery. */
export const BOOT_SHELL_CSS = `
${WORKSPACE_FRAME_CSS}
.lody-boot-shell {
  --lody-frame-left: var(--lody-frame-gutter, 8px);
  --lody-frame-canvas: hsl(${light.canvas});
  --lody-frame-border: hsl(${light.frameBorder} / .6);
  position: fixed; inset: 0; z-index: 30; box-sizing: border-box;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
  display: flex; overflow: hidden; background: hsl(${light.sidebar}); color: hsl(${light.status});
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  opacity: 1; visibility: visible; transition: opacity 160ms ease-out, visibility 0s;
}
.dark .lody-boot-shell {
  --lody-frame-canvas: hsl(${dark.canvas}); --lody-frame-border: hsl(${dark.frameBorder} / .6);
  background: hsl(${dark.sidebar}); color: hsl(${dark.status});
}
.lody-boot-shell[data-active=false] {
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity 160ms ease-out, visibility 0s 160ms;
}
.lody-boot-shell__sidebar {
  flex: none; box-sizing: border-box; width: 0; height: 100%;
  transition: width ${BOOT_SHELL_MOTION.durationMs}ms ${BOOT_SHELL_MOTION.easing};
}
[data-lody-boot-sidebar] .lody-boot-shell__sidebar,
.lody-boot-shell[data-sidebar=shown] .lody-boot-shell__sidebar {
  width: var(--lody-boot-sidebar-width, ${BOOT_SHELL_SIDEBAR_WIDTH.default}px);
}
.lody-boot-shell.lody-boot-shell[data-sidebar=hidden] .lody-boot-shell__sidebar { width: 0; }
[data-lody-boot-sidebar] .lody-boot-shell:not([data-sidebar=hidden]),
.lody-boot-shell[data-sidebar=shown] { --lody-frame-left: 0px; }
.lody-boot-shell__main {
  position: relative; display: flex; flex: 1; min-width: 0; align-items: center; justify-content: center;
  transition: margin ${BOOT_SHELL_MOTION.durationMs}ms ${BOOT_SHELL_MOTION.easing},
    border-radius ${BOOT_SHELL_MOTION.durationMs}ms ${BOOT_SHELL_MOTION.easing},
    border-color ${BOOT_SHELL_MOTION.durationMs}ms ease-out, box-shadow ${BOOT_SHELL_MOTION.durationMs}ms ease-out;
}
html:not([data-lody-boot-layout=workspace]) .lody-boot-shell:not([data-layout=workspace]),
.lody-boot-shell.lody-boot-shell[data-layout=plain] { background: var(--lody-frame-canvas); }
html:not([data-lody-boot-layout=workspace]) .lody-boot-shell:not([data-layout=workspace]) .lody-boot-shell__main,
.lody-boot-shell.lody-boot-shell[data-layout=plain] .lody-boot-shell__main {
  margin: 0; border-color: transparent; border-radius: 0; box-shadow: none;
}
.lody-boot-shell[data-mobile=true],
[data-lody-boot-mobile=true] .lody-boot-shell:not([data-mobile=false]) {
  padding: 0; background: var(--lody-frame-canvas);
}
.lody-boot-shell[data-mobile=true] .lody-boot-shell__sidebar,
[data-lody-boot-mobile=true] .lody-boot-shell:not([data-mobile=false]) .lody-boot-shell__sidebar { width: 0; }
.lody-boot-shell.lody-boot-shell[data-mobile=true] .lody-boot-shell__main,
[data-lody-boot-mobile=true] .lody-boot-shell:not([data-mobile=false]) .lody-boot-shell__main {
  margin: 0; border-color: transparent; border-radius: 0; box-shadow: none;
}
.lody-boot-shell__mark {
  display: block; width: ${BOOT_SHELL_MARK_SIZE}px; height: ${BOOT_SHELL_MARK_SIZE}px;
  animation: lody-boot-shell-in .24s ease-out calc(120ms - var(--lody-boot-elapsed, 0ms)) both,
    lody-boot-shell-breathe 2.4s ease-in-out calc(1200ms - var(--lody-boot-elapsed, 0ms)) infinite;
}
.lody-boot-shell[data-active=false] .lody-boot-shell__mark { animation-play-state: paused; }
.lody-boot-shell__status {
  position: absolute; top: calc(50% + 40px); left: 24px; right: 24px; text-align: center;
  animation: lody-boot-shell-in .24s ease-out max(400ms, calc(900ms - var(--lody-boot-elapsed, 0ms))) both;
}
.lody-boot-shell__status-title { font-size: 13px; font-weight: 500; }
@keyframes lody-boot-shell-in { from { opacity: 0; } }
@keyframes lody-boot-shell-breathe { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) {
  .lody-boot-shell, .lody-boot-shell__sidebar, .lody-boot-shell__main { transition: none !important; }
  .lody-boot-shell__mark, .lody-boot-shell__status { animation: none; }
}
`.trim();

export const BOOT_SHELL_MARKUP =
  '<div class="lody-boot-shell" data-lody-boot-shell="" aria-hidden="true">' +
  '<div class="lody-boot-shell__sidebar"></div>' +
  '<div class="lody-boot-shell__main lody-workspace-card">' +
  `<img class="lody-boot-shell__mark" src="${BOOT_SHELL_MARK_DATA_URL}" alt="" width="${BOOT_SHELL_MARK_SIZE}" height="${BOOT_SHELL_MARK_SIZE}" decoding="sync">` +
  '</div></div>';
