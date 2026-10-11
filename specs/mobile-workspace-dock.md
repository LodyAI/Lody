# Mobile workspace dock

Status: draft
Translation: current

[中文](mobile-workspace-dock.zh.md)

Scroll down to minimize navigation and up to reveal it. Lists and imperative editor signals share a 14px directional threshold, reset on reversal; reaching the top within 4px always expands. Tapping the minimized tab expands without scrolling and resets the threshold.

The selected icon remains the same visible 24×24 element. Labels, selection fill and other tabs fade together. Reversals preserve position and velocity; reduced motion jumps to the target. Hidden tabs cannot receive input, and focus moves to the selected tab before another tab disappears.

Both themes follow this behavior. Unmatched selection keeps navigation expanded; changing tabs never selects one implicitly. Instances remain independent, including matching legacy `layoutId` values. Resizing or omitting the new-chat action preserves available-width and safe-area layout.

## Evidence

[Component](../packages/components/src/components/mobile/mobile-workspace-tabbar.tsx) · [Decision and validation limits](../.agents/notes/implemented/bug-fix/2026-10-05-mobile-workspace-dock-motion.md)
