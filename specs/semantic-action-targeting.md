# Semantic action targeting

Status: draft
Translation: current

[中文](semantic-action-targeting.zh.md)

When a user opens a file in the right panel, moves the pointer back to the
conversation, and presses Cmd/Ctrl+W, the right panel's active tab should close.
Incidental pointer movement must not replace an explicit content interaction.
A pointer resting on an inactive tab can select its region, not that individual tab,
only when no explicit interaction owns the close target. The Developer Mode beta
“Pointer-aware close shortcut” defaults off and covers
desktop close routing; other shortcuts retain their existing targeting. Both the
developer master switch and this per-device opt-in must be enabled. Disabling
either immediately restores legacy targeting, retaining the saved opt-in.

## Intent and ownership

Visible surfaces declare semantic action scopes and supported actions. A single
window-local resolver selects a scope; the surface owns its active tab and close
lifecycle. Selection must not depend on screen halves, CSS layout, or component
mount order. Hidden or unmounted surfaces cannot receive actions.

An active modal or menu blocks background close. Explicit content opening or tab
selection chooses the destination scope, even when initiated elsewhere. Clicks,
keyboard input/navigation, and non-zoom wheel input choose their containing scope.
That explicit ownership persists until another deliberate action or a lifecycle
reset; pointer movement and elapsed time cannot replace it. Programmatic focus
and scroll restoration do not claim ownership. The close chord and modifier keys
alone do not change ownership.

Without explicit ownership, continuous hover in one visible scope for 250 ms may
select it without moving the text caret. Crossing a scope does not select it;
clicks and keyboard/wheel input act immediately. Pending hover is cancelled on
pointer exit, dragging, blocking layers, hidden/removed targets, and resets.
Without a committed selection, use a valid focused scope, then the conversation.
An asynchronous open may claim its destination only if no newer deliberate input,
open request, route change, or window blur superseded it; disposal or disabling the
beta also invalidates its claim. A failed open that creates no tab makes no claim.

Pointer exit invalidates hover targeting. Route changes and window blur clear
transient ownership. Removed targets block that invocation instead of redirecting
it; a later deliberate interaction can choose another scope. A small visual cue on
the targeted tab strip should make the effective close scope visible.

## Close outcomes

| Selected scope                                                          | Result                                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Right panel with an active tab                                          | Invoke that tab's existing close handler.                                                      |
| Empty visible right panel                                               | Collapse the panel and transfer active scope to the conversation; this invocation ends.        |
| Conversation with multiple tabs                                         | Close the active conversation tab.                                                             |
| Conversation with one tab and explicit ownership                        | Retain the native window close/hide behavior in [desktop windows](desktop-windows.md).         |
| Conversation with one tab selected only by hover/focus/default fallback | Block window close while another visible close scope exists; otherwise retain native behavior. |
| Modal, cancelled confirmation, or pending/failed close                  | Consume or block; do not try another scope.                                                    |
| No session surface, such as Chat Landing                                | Retain explicit shell window-close policy.                                                     |

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
interaction class (movement, click, exit, wheel, or keyboard) to its owning renderer.
Movement remains weak evidence; click, wheel, and keyboard input take explicit ownership.
Hidden views cannot claim ownership, and close accelerators do not overwrite a
newer pointer target. No page contents, coordinates, or typed keys cross that bridge.
Pointer entry into an iframe can select its host scope after the same dwell without reading the frame.
Keyboard interaction inside cross-origin Managed Preview frames still needs a
separate bridge and is not covered by this beta. Browser-owned Cmd+W
on the web is outside this desktop experiment.

## Evidence and open work

The opt-in implementation is available; the Spec remains a draft. The
[ownership decision](../.agents/notes/implemented/architecture/2026-10-14-close-intent-ownership.md)
records persistent explicit ownership, guarded async claims, dwell, validation,
and remaining native/iframe limits. It revises the immediate-pointer policy in the
[earlier decision](../.agents/notes/implemented/architecture/2026-09-22-semantic-action-targeting.md).
The tab-strip cue represents the committed target, never a pending hover candidate.
No measured usability benefit or universal industry-default policy is claimed.
