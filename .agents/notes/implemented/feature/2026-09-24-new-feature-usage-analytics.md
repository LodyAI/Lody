# Usage analytics for features shipped 2026-08-25 → 2026-09-23

Status: implemented
Translation: current

[中文](2026-09-24-new-feature-usage-analytics.zh.md)

## Abstract

Most features shipped between 0.86.2 and 0.100.0 had no PostHog usage events, so
their adoption (who used it, how often, whether they came back) was invisible.
Each reviewed feature now emits a dedicated `<domain>/<action>` event from renderer
code at the point the action actually succeeds, carrying only enums, counts, and
booleans. Events are unsampled (tier A) except the two high-frequency interactions,
outline jumps and fuzzy-search selections, which are tier C. Local OSS builds still
send nothing, because the PostHog client is absent there.

## Decisions

- **One dedicated event per action**, not a generic `feature/used { feature }`,
  matching the existing `session/*` naming so funnels need no property filters.
- **Emit on success, not on intent.** Share, copy, export, save, and native calls
  capture after the promise resolves; cancelled dialogs and automatic actions
  (auto-copy after publish, stale-draft cleanup) are not counted.
- **Renderer only.** Electron main and CLI telemetry are hard-disabled by the
  platform contract; desktop windows, auto-launch, and file actions are captured
  where the renderer initiates them. `openDesktopWindow` now takes an explicit
  `source` and captures through `deferredPostHog`, because it is lib code called
  from memoized sidebar rows.
- **No PII.** File kinds come from `getAnalyticsFileKind` (`html|md|image|pdf|other`);
  the DeepSeek custom base URL is reported only as a boolean.

## Scope reviewed and excluded

Deliberately not instrumented after review: queue steering, Zen layout, the
current/all-projects toggle in `@` session mentions, DeepSeek Ask Question, and
anonymous views of public share pages. New agents and models are already covered
by `agent_type`/`model_id` on `session/start_requested` and the CLI `acp/*` events.
The mobile share-sheet-to-task flow was not found in the public or private sources,
so it has no event yet.

## Event inventory

| Feature                 | Events                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public session share    | `share/created {child_session_count, source: ui\|mcp}`, `share/revoked`, `share/link_copied`                                                      |
| Export images / context | `export/chat_png_created`, `export/chat_png_copied`, `export/usage_image_created {orientation, action}`, `export/context_markdown_copied {scope}` |
| Session link paste      | `mention/session_link_pasted {converted, surface}`                                                                                                |
| Prompt Shortcuts        | `prompt_shortcut/created\|updated\|deleted\|invoked`                                                                                              |
| Agent Roles             | `agent_role/applied {source, cross_machine, visibility}`; `agent_role_used` on `session/start_requested`                                          |
| Fuzzy pickers (tier C)  | `picker/search_selected {picker: model\|skill, term_length, rank, result_count}`                                                                  |
| Desktop windows         | `window/opened {kind, source}`                                                                                                                    |
| File preview            | `file_preview/opened`, `file_preview/downloaded`, `file_preview/remote_port_confirmed {decision}`                                                 |
| File actions            | `session/file_action {action, source, file_kind}`                                                                                                 |
| Font size               | `settings/font_size_changed {from, to}`                                                                                                           |
| Low-frequency settings  | `settings/changed {key, value}` for launch-at-login, sidebar project names, DeepSeek base URL, app icon                                           |
| Codex busy retry        | `session/agent_busy_retry {trigger, attempt}`, `session/agent_busy_retry_cancelled`                                                               |
| Codex goals             | `session/goal_resume_requested`, `session/goal_clear_requested`                                                                                   |
| Plan panel              | `plan_panel/opened {is_subagent}` (child session)                                                                                                 |
| Outline (tier C)        | `outline/jumped {from_hover_preview, entry_count}`                                                                                                |

## Verification and limits

`tsgo --noEmit` for `@lody/components` passes, and the existing suites for share
management, capacity auto-retry, Role selection, model search, and file actions
pass. No new tests were added, because a test that checks a mocked capture call
cannot detect a regression in user behavior. The app-icon event also fires on macOS
Electron, which shares the component. `is_subagent` means "plan shown in a child
session", because plans have no sub-agent identity of their own.
