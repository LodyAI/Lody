export const MOBILE_LAYOUT_BREAKPOINT = 768;

/**
 * Narrowest width a desktop window may be resized to. The layout family is
 * chosen by shell/device identity, never by width alone: a desktop window
 * below MOBILE_LAYOUT_BREAKPOINT keeps the desktop renderer in its compact
 * presentation (overlay sidebars) instead of switching to the mobile
 * renderer. This floor protects window chrome — header rows, traffic
 * lights, caption buttons — not the layout contract.
 */
export const DESKTOP_WINDOW_MIN_WIDTH = 400;
