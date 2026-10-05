# Mobile workspace dock

Status: draft
Translation: current

[中文](mobile-workspace-dock.zh.md)

When reading a mobile workspace or project list, scrolling down minimizes the
navigation pill to its selected tab. Scrolling up reveals navigation again without
requiring a return to the top. Both native DOM scrolling and imperative editor
scroll signals follow this behavior. Direction changes reset accumulated distance;
14px of travel in one direction triggers the change, while reaching the top within
4px always expands. Tapping the minimized tab expands in place and resets the
threshold without moving the content.

The selected icon remains one visible 24×24 element throughout the transition.
The dock resizes without stretching its contents, and reversals preserve position
and velocity. Labels, selection fill and other tabs fade with the same transition.
Reduced motion jumps directly to the destination. Invisible controls cannot receive
pointer or keyboard input; focus in a disappearing tab moves to the selected tab.

The shared component owns motion and scroll interpretation. Callers retain tab
keys, icons, translated labels, selection and the optional new-chat action. iOS and
Material use the same behavior. No matching selection leaves the dock expanded;
changing or reordering tabs must not substitute another tab as selected. Instances
are independent even when legacy `layoutId` values match. Resizing and omitting the
new-chat action preserve the available-width and safe-area layout.

## Evidence

- [Shared component](../packages/components/src/components/mobile/mobile-workspace-tabbar.tsx)
- [Browser coverage](../packages/components/tests/e2e/mobile-workspace-tabbar.spec.ts)
- [Decision and validation limits](../.agents/notes/implemented/bug-fix/2026-10-05-mobile-workspace-dock-motion.md)

This draft records the accepted motion direction; it is not a linked human approval
of this Spec revision. Browser tests cannot establish physical Android performance.
