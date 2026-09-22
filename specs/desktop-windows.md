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

The optional developer window warm-up prepares the shell, not target Session data.
Keep its neutral cover until the target conversation has loaded and synced, the
workspace landing is mounted, or absence is confirmed after the target Session’s
metadata projection settles. Unrelated metadata failures must not block that decision. Loading text and sidebar content are not readiness signals. The cover
expires after five seconds so slow/offline/error states retain their recovery UI;
this fallback is not a promise of completed loading or instant opening.
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
