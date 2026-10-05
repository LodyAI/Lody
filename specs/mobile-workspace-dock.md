# Mobile workspace dock

Status: draft
Translation: current

[中文](mobile-workspace-dock.zh.md)

When reading a workspace or project list, scroll down to minimize navigation and up to reveal it. DOM and imperative editor scrolling share a directional 14px threshold, reset on reversal; reaching the top within 4px always expands. Tapping the minimized tab expands in place and resets the threshold.

The selected icon remains the same visible 24×24 element. Resizing never stretches content; interrupted reversals preserve position and velocity. Labels, selection fill and other tabs fade together. Reduced motion jumps to the target. Hidden controls cannot receive pointer or keyboard input; focus moves from a disappearing tab to the selected tab.

The shared component owns motion and scroll interpretation. Callers own keyed tabs, theme icons, translated labels, selection and the optional new-chat action. Both themes behave alike. Unmatched selection keeps navigation expanded; tab changes never select another tab implicitly. Instances stay independent, including matching legacy `layoutId` values. Resize and optional-action changes preserve available-width and safe-area layout.

## Evidence

[Component](../packages/components/src/components/mobile/mobile-workspace-tabbar.tsx) · [Browser tests](../packages/components/tests/e2e/mobile-workspace-tabbar.spec.ts) · [Decision and validation limits](../.agents/notes/implemented/bug-fix/2026-10-05-mobile-workspace-dock-motion.md)

This draft records the accepted direction, not linked human approval of this revision. Browser tests do not establish Android device performance.
