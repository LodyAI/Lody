# sessions — directory index

What each file in this directory is responsible for. Binding rules live in
[AGENTS.md](AGENTS.md); the long-form explanations it links to live under
[`.agents/docs/`](../../../../../.agents/docs/) with the `sessions-` prefix.

## Page shell and tabs

| File | Responsibility |
| --- | --- |
| `session-detail.tsx` | Outer session shell: top tabs, side panel, session-switch reset, tab closer |
| `desktop-session-detail-layout.tsx` | Desktop two-column layout and the side-panel expand/collapse animation |
| `session-conversation-page.tsx` | Shared full-page composition used by `SessionConversationPage.stories.tsx` |
| `session-tab-bar.tsx` | Desktop merged top row: session tab pills, status slot, drag sources |
| `adaptive-tab-strip.tsx` | Width sharing for the tab pills |
| `session-side-panel-tab-bar.tsx` | Right-panel tab strip (fixed panels, side chats, viewers) |
| `session-tab-close-target.ts` | Registration for the Cmd/Ctrl+W close target |
| `session-list-rows.ts` | Sidebar/tab row derivation, including child grouping by parent |
| `child-tab-empty-state.tsx` | Suggestions shown in an empty child tab |
| `session-not-found.tsx` | Missing-session surface |
| `session-mention-drop-layer.tsx` | Drop target that turns a dragged tab into a mention |
| `session-pin.tsx`, `session-pin-context.tsx` | Pinned content above the stream |
| `session-search-context.tsx` | In-conversation search context |

## Conversation surface and composer

| File | Responsibility |
| --- | --- |
| `session-chat-interface.tsx` | Conversation surface: stream, header variants, read receipts, launchers |
| `draft-session-chat-interface.tsx` | Draft variant of the conversation surface |
| `session-chat-input-area.tsx` | Composer: attachments, run-config footer, submit |
| `message-queue/` | Queued turns ([scope AGENTS.md](message-queue/AGENTS.md)) |
| `session-message-submit-route.ts` | Send vs. queue vs. steer routing decision |
| `desktop-run-config-menu.tsx` | Desktop run-config dropdown + permission-mode button |
| `recent-run-config-menu-group.tsx` | "Recently used" run-config entries |
| `composer-agent-role-panel.tsx`, `agent-role-detail-pane.tsx` | Agent Role selection and the single Role detail pane |
| `floating-permission-request.tsx`, `ask-user-question-card.tsx` | Floating permission requests and agent questions |
| `notification-permission-prompt.tsx` | Notification permission ask |
| `session-fork-destination-menu.tsx` | Fork target choice (shared workspace tab vs. new worktree) |
| `rename-session-dialog.tsx` | Session rename dialog |

## Info bar, status, and session actions

| File | Responsibility |
| --- | --- |
| `session-info-bar.tsx`, `session-info-chips.tsx`, `info-chip.tsx` | Canonical cluster + fixed stage bar above the composer |
| `session-info-action-state.ts` | Which repository action the context stage offers |
| `session-status-strip.tsx` | Priority-ordered connection/machine status (story coverage only) |
| `session-syncing-indicator.tsx` | Catch-up spinner pinned to the bar's right edge |
| `session-goal-banner.tsx`, `session-goal-control.ts` | Goal actions reused by the goal chip |
| `session-plan-bar.tsx`, `session-tasklist-mapping.ts` | Plan/tasklist presentation |
| `scheduled-tasks-panel.tsx` | Scheduled task list reused by the schedule chip |
| `session-usage-popover.tsx` | Usage/context popover |
| `pull-request-badge.tsx`, `pr-merge-button.tsx`, `pr-merge-method.ts` | PR identity and merge split-button |
| `pr-tab-container.tsx`, `pr-tab-view.tsx` | PR side-panel tab |
| `create-pr-prompt.ts`, `session-pr-prompts.ts`, `session-pr-agent-action.ts` | Agent prompts behind Create PR / Fix CI / Resolve Conflicts |
| `diff-pr-analytics.ts` | Analytics for diff and PR surfaces |
| `auto-review-menu-item.tsx`, `auto-review-info.tsx`, `auto-review-status.tsx` | Auto review checkbox, setup explanation, and run banner |
| `use-capacity-auto-retry.ts` | Capacity-error retry behaviour |

## File, diff, and browser surfaces

| File | Responsibility |
| --- | --- |
| `session-changes-sidebar.tsx` | All Changes panel |
| `session-conversation-diff-panel.tsx`, `session-conversation-diff-types.ts` | Conversation/turn diff page |
| `use-session-conversation-diff-data.ts`, `use-session-all-changes-diff-data.ts`, `use-session-diff-summary.ts`, `session-diff-summary.ts` | Diff data and summary derivation |
| `use-diff-focus-scroll.ts` | Scroll-to-focused-hunk behaviour |
| `session-file-content-view.tsx`, `session-monaco-text-viewer.tsx` | File viewer and its Monaco editor window |
| `session-file-image-preview.tsx`, `session-file-binary-preview.tsx` | Non-text previews |
| `session-file-diff-notice-card.tsx`, `session-file-error-state.tsx` | File notices and the error card that offers file actions |
| `session-file-actions-menu.tsx` | Shared file-action menu rendering |
| `session-file-quick-open.tsx` | Quick open over the file index |
| `components/` | File tree ([scope AGENTS.md](components/AGENTS.md)) |
| `session-browser-panel.tsx`, `session-browser-toolbar.tsx`, `session-browser-resume-state.ts` | Session Browser panel, address bar, and resume state |
| `public-browser-surface.tsx` | Public engine host (Electron `WebContentsView`) |
| `managed-preview-surface.tsx`, `managed-preview-frame-cache.ts` | Managed Preview host and its LRU frame cache |
| `static-html-preview-document.ts`, `session-html-attachment-action.ts` | Static `srcdoc` document policy for complete HTML text |

## Long-form explanations

- [Session tabs, top bar, and `?tab` routing](../../../../../.agents/docs/sessions-tabs-routing.md)
- [Side panel, side chats, opened sessions, browser mount](../../../../../.agents/docs/sessions-side-panel.md)
- [Browser engines, Managed Preview, HTML viewer, annotations](../../../../../.agents/docs/sessions-browser.md)
- [Conversation surface](../../../../../.agents/docs/sessions-surface.md)
- [Run config and Agent Roles](../../../../../.agents/docs/sessions-run-config.md)
- [Live status and dispatch](../../../../../.agents/docs/sessions-live-status.md)
- [Composer info bar](../../../../../.agents/docs/sessions-info-bar.md)
- [Auto review and status slot](../../../../../.agents/docs/sessions-auto-review.md)
- [File surfaces](../../../../../.agents/docs/sessions-file-surfaces.md)
- [Render-cost invariants](../../../../../.agents/docs/sessions-render-cost.md)
- [Stories and Storybook fidelity](../../../../../.agents/docs/sessions-stories.md)
