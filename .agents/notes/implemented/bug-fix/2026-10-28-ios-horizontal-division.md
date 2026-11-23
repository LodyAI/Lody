# Adapt mobile conversations to horizontal divisions

Status: implemented
Translation: current

[中文](2026-10-28-ios-horizontal-division.zh.md)

## Abstract

On a full-width horizontal UIKit division, the mobile conversation limits its
message stream to the upper panel and keeps its composer and associated controls
in the lower panel. With a docked keyboard, the regular native keyboard offset
owns layout so the composer moves above the keyboard. The component tree and
unsent drafts remain mounted through both transitions. If either panel is too
small, or the division disappears, the normal layout applies.

For the active home chat tab, the first existing group occupies the upper panel
and the other groups occupy the lower panel. This preserves bucket membership,
opened-by trees, preview limits, row actions and collapse state without duplicated
conversations. The archive uses the same whole-group split through two home-owned
scroll regions while keeping one list component for selection, select-all and
delete confirmation; it never duplicates a row. The normal list returns during
keyboard use or search, with fewer than two groups, or when either panel is too small.
On the Projects tab, recent shortcuts and the source selector occupy the upper
panel, with the selected source list below; search, keyboard and empty recents
restore the normal layout. The embedded Schedules list uses compact rows at
mobile widths even when the viewport crosses the desktop CSS breakpoint, so
its target and action controls remain visible. The mobile Settings category page
places account and current-workspace identities together beside the workspace’s last-7-day Token and estimated
cost above the division, with all settings categories below. It reuses the
settings usage cache and capability gate, distinguishes loading from zero, and
aggregates the actual hourly timeline by UTC day for a compact skyline and model-share ring linking to the usage page, which also defaults to the week. It
retains one keyboard focus scope and independent panel scrolling. It remeasures after the page entry animation.
The usage detail keeps its range selector and side-by-side totals above the
division and scrolls its charts below. The workspace detail keeps workspace
identity above and the member list and other controls below. Both return to the
ordinary single scroll when the keyboard appears, without replacing the page
component or its state. Account settings put the profile above and account resources below. Appearance places theme, language and font size above and rendering controls below; preferences put notifications and input above and session controls below. Both regions scroll separately without remounting their contents during fold or keyboard transitions. Project detail settings keep project and worktree controls above, and skills and other project settings below; their bottom panel reserves room for the dock. Other detail pages retain their existing layout.

About settings put version and build information above the division and links and optional developer controls below, retaining the developer-mode reveal state through transitions. GitHub settings put connection and identity above, with the repository list and search below; the input remains mounted during keyboard and fold changes. The Agents page puts its machine selector above and provider list below when machine selection is available; otherwise it retains ordinary scrolling.

The mobile session actions, conversation-tab, workspace-switcher, project-skills and history sheets are independently scrollable and fit the lower panel. The full-page new-chat flow keeps its target controls above the division and the composer below. The filter, run-config, worktree and workspace creation/deletion sheets also fit below the division until a keyboard appears, when the existing keyboard lift and viewport cap take over without replacing the content. The existing 85dvh limit remains when no
usable division exists. Each sheet retains its existing fallback height when there is no usable division. Keyboard-capable sheets preserve their inputs and use the shared keyboard-aware scrolling contract. Generic drawer positioning is unchanged. Root confirmation dialogs fit the lower panel when the keyboard is hidden; nested dialogs retain their host's positioning.

The outer Settings scroll area stays mounted in both folded and ordinary layouts;
the folded panels take over scrolling only while a usable division is present. Its
content is constrained to the viewport height during a fold so the lower panel can
scroll instead of extending below the screen.
The filter sheet disables Vaul's input repositioning only in the native iOS shell,
where the native keyboard offset owns it. Browsers and Android retain Vaul's
visual-viewport handling.

## Evidence and scope

The authenticated iOS 27.1 simulator showed the system keyboard entirely in
the lower panel, with the input above the fold. Without the keyboard, a chat
and composer appeared on opposite sides of the fold; an existing conversation
remained visible through open/part-open changes. Tests exercise geometry,
keyboard transitions and draft retention, and render both real sheets. The
other settings detail pages, general dialogs, and physical-device
acceptance remain out of scope; they can still span a horizontal division. Geometry comes from UIKit,
not a device model or fixed display size.
