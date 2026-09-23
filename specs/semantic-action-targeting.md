# Semantic action targeting

Status: draft
Translation: current

[中文](semantic-action-targeting.zh.md)

When a user moves the pointer from the conversation to the right panel and presses
Cmd/Ctrl+W, the right panel's active tab should close. A pointer resting on an
inactive tab selects its region, not that individual tab. The Developer Mode beta
“Pointer-aware close shortcut” defaults off and covers
desktop close routing; other shortcuts retain their existing targeting. Both the
developer master switch and this per-device opt-in must be enabled. Disabling
either immediately restores legacy targeting, retaining the saved opt-in.

## Intent and ownership

Visible surfaces declare semantic action scopes and supported actions. A single
window-local resolver selects a scope; the surface owns its active tab and close
lifecycle. Selection must not depend on screen halves, CSS layout, or component
mount order. Hidden or unmounted surfaces cannot receive actions.

An active modal or menu blocks background close. Otherwise the
latest deliberate pointer movement/click or keyboard interaction selects a scope.
Keyboard input in a focused conversation can therefore reclaim ownership from a
stationary pointer over the right panel. The close chord itself does not change
ownership. Programmatic focus restoration must not override a later pointer choice.
Without an interaction history, use a valid focused scope, then the conversation.

Pointer exit invalidates hover targeting. Route changes and window blur clear
transient ownership. Removed targets block that invocation instead of redirecting
it; a later deliberate interaction can choose another scope. A small visual cue on
the targeted tab strip should make the effective close scope visible.

## Close outcomes

| Selected scope | Result |
| --- | --- |
| Right panel with an active tab | Invoke that tab's existing close handler. |
| Empty visible right panel | Collapse the panel and transfer active scope to the conversation; this invocation ends. |
| Conversation with multiple tabs | Close the active conversation tab. |
| Conversation with one tab | Retain the native window close/hide behavior in [desktop windows](desktop-windows.md). |
| Modal, cancelled confirmation, or pending/failed close | Consume or block; do not try another scope. |
| No session surface, such as Chat Landing | Retain explicit shell window-close policy. |

Closing the last right-panel tab may collapse that panel. After a successful
collapse, visibly transfer active scope and keyboard focus to the conversation.
Subsequent close invocations may act there without another click. Normal key
repeat is unchanged; the experiment adds no repeat suppression. Each invocation
closes only its selected target. An already hidden right panel is not an
empty visible target. Cancellation or failure does not transfer ownership.
File dirty confirmation and Side Chat termination/deletion remain owned by their
existing handlers; semantic routing does not redefine their lifecycle.

Native menu close and the accelerator use the same resolver. DevTools retains its
native close priority. The native public browser forwards only its browser id and
pointer/keyboard
interaction class to its owning renderer. Hidden views cannot claim ownership,
and close accelerators do not overwrite a newer pointer target. No page contents
or typed keys cross that bridge. Pointer entry into an iframe selects its host scope without reading the frame.
Keyboard interaction inside cross-origin Managed Preview frames still needs a
separate bridge and is not covered by this beta. Browser-owned Cmd+W
on the web is outside this desktop experiment.

## Evidence and open work

The opt-in implementation is available; the Spec remains a draft. [The design note](../.agents/notes/implemented/architecture/2026-09-22-semantic-action-targeting.md)
records code evidence, validation, and remaining native/iframe limits. The beta
uses immediate pointer movement and a tab-strip cue without moving the text caret.
Subsequent typing or keyboard navigation takes ownership back. Hover dwell is
deferred for evaluation; this is not an industry-default claim. Menus and dragging
do not retarget background actions. Window-close policy remains separate; the note
records contrary precedent from VS Code.
