# Mermaid inline view

Status: draft
Translation: current

[中文](mermaid-inline-view.zh.md)

When a reader pans or zooms a diagram to inspect a node, clicking elsewhere must
leave that node in place. Activation adds no outline or ring.

Clicking outside, moving keyboard focus away, Escape, toggling activation off,
or opening the full-screen viewer stops inline interaction without resetting
pan or zoom. Clicking the diagram again resumes from that view. Each rendered
diagram retains its own view for its mounted lifetime; replacement or remount
may start at the initial view. This does not promise persistence across sessions.

An inactive diagram does not consume pinch gestures. Ordinary wheel scrolling
continues to scroll the conversation in either state. Touch retains its viewer
entry behavior. The full-screen viewer starts independently at natural size and
leaves the inline view unchanged when opened or closed. Inside the full-screen
viewer, a one-finger touch pans the diagram and a two-finger touch pinches around
the fingers' centre; trackpad pinch uses the platform's ctrl/meta-modified wheel
event. Oversized diagrams remain reachable from both edges while they are
scrolled.

## Evidence

- [Interaction owner](../packages/components/src/components/ai-gui/use-mermaid-diagram-canvas.tsx)
- [Behavioral tests](../packages/components/tests/markdown-mermaid-fullscreen.test.tsx)
- [Decision](../.agents/notes/implemented/bug-fix/2026-09-21-mermaid-retain-view.md)
- [Viewer gesture decision](../.agents/notes/implemented/bug-fix/2026-09-27-mermaid-and-image-viewer-gestures.md)
