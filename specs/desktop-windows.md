# Desktop multi-window

Status: draft
Translation: current

English | [中文](desktop-windows.zh.md)

Users can view conversations and workspaces side by side; opening a window leaves
its source window unchanged.

| Action                                                     | Result                          |
| ---------------------------------------------------------- | ------------------------------- |
| Ordinary Session click or workspace switch                 | Navigate in the current window  |
| Command-click on macOS, Control-click on other desktops    | Open the target in a new window |
| Session more/context menu: Open conversation in new window | Open a conversation window      |

Dragging out to create windows is unsupported; Session dragging retains mention
insertion. The workspace selector shows the modifier-click hint at its bottom.
Its context menu offers Open in new window without switching the current workspace.
Session menus order actions as expand/collapse children, pin, mark unread, rename;
copy link, copy branch, share; open PR, go to source Session, open in new window;
archive. Separate groups without headings or empty groups, hide unavailable
actions, and keep Open in new window penultimate and Archive last in ordinary text.

Conversation windows initially collapse the left sidebar, open the requested
conversation, and focus its composer once. The sidebar can be expanded.
Workspace windows retain full navigation. Navigation, draft tabs, and panel state
are independent per window.

The optional developer window warm-up prepares the shell and, in local mode, the
implicit workspace runtime, Repo, and metadata sync before a target is selected.
A matching claim retains that runtime, including initialization still in flight.
The neutral route does not mount target Session UI or publish a workspace route.
Local-only windows reuse same-workspace peer metadata and already loaded Session
snapshots without sharing persistence or sync cursors. Snapshot import merges local
edits; authoritative synchronization continues independently.
On macOS local mode, the same opt-in spare may become a target-specific prepared
Session after row hover/keyboard focus or opening a Session menu. Main bounds this
to one hidden view, expires it, and cancels it when its source closes or the intent
changes. Before presentation, this view may render and synchronize but must not
mark read, claim workspace notification ownership, autofocus, or refresh external
history as an opening side effect. Preparation leaves the source view unchanged.
A matching claim presents the existing renderer without navigation; only actual
presentation activates these effects. Readiness belongs to the target, sender and
preparation generation, and is revoked when content or viewport becomes invalid.
A miss or an early click still pays unfinished preparation; this is not a universal
instant-open guarantee. Other platforms retain neutral-shell warmup.

A claimed warm window stays natively hidden until the matching target has painted:
conversation history must be hydrated (an empty conversation must be synced), the
workspace landing mounted, or absence confirmed after that Session's metadata
projection settles. Nonempty conversations must also finish virtual-list hydration
and initial scroll restoration, so a CSS-hidden message viewport cannot authorize
presentation. Unrelated metadata failures must not block the decision.
Loading/sidebar text and an index-only history count are not readiness signals.
There is no opaque renderer cover. Main reveals the recovery UI after five seconds
if readiness never arrives; this is not a completed-load signal or an instant-open
guarantee. Keep rendering unthrottled while hidden preparation runs, then restore
the previous policy. Prepare the replacement spare only after the claimed window
is shown. Measure click-to-show separately from whether the first visible frame
contains content.
Once claimed, the window follows ordinary product-window lifetime rules and remains
open when other windows close. Crash recovery reloads its bound target, never the
neutral warm route. Closing it must not cancel a replacement spare's timeout.

Composer drafts persist per workspace, isolated from other workspaces, regardless
of which window opened them. All Chat Landing entries in a workspace reuse its
composer draft. New conversation changes only the target project, preserving input;
clear the draft only after the first message is successfully written to a Session.
Closing another workspace window does not stop the CLI or Agent. Close menus and
shortcuts act on the current window.

Cmd/Ctrl+W in the conversation region closes the active tab when multiple tabs
remain. With one tab, including a draft, it closes the current window without
changing shared Session closure state. A focused side panel closes its active tab
first. Explicit tab × still closes the tab. Primary and new conversation windows
follow the same rule, preserving each window's native close/hide behavior.
Application shortcut settings are device-wide and changes propagate to all open
windows; execution acts only in the window receiving the key. The original window
retains existing close/tray behavior; other workspace windows are not automatically
restored.

Hiding the sidebar unmounts its content and pauses Session prefetch; data required
by the current conversation and Tasks page continues syncing. Only one window per
workspace runs notifications, badges, and background status checks, handing off
on exit. Cache clearing and logout are application-wide and close other windows
to release connections.

Workspace windows use the existing platform directory; the public desktop still
has one local workspace. Shared UI multi-workspace entries must not change other
windows' targets through global account selection.

Requirement: [Issue #526](https://github.com/LodyAI/Lody/issues/526).
