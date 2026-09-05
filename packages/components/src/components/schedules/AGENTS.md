# Schedule UI

`CLAUDE.md` is a symlink to this file.

- One workspace-shell Registry subscription supplies list and provenance links;
  details acquire/release one Schedule store through WorkspaceRuntime. All writes use
  `withScheduleStore`, retaining an active uploader ref until synchronization. Never load
  every definition for listing. The developer + beta gate hides navigation,
  commands and background subscriptions together on every platform.
- `schedule-view.tsx` is presentational and has Storybook fixtures;
  `schedules-workspace.tsx` owns domain writes, selectors and route composition.
  Agent/Project selectors live in `components/shared`; Task wrappers own Task
  visual tokens. Keep Schedule independent of delegated Task state.
- Save requires explicit automation consent and Agent permission mode. Original
  local directories require scope consent; elevated modes stay visibly marked.
  Run now confirms saved configuration and may overlap existing work. Pause does
  not cancel an already submitted Session.
- Owner-only reduction of authority (pause/delete) remains possible when the
  machine is gone or outdated. Creating/editing/resuming/running requires the
  target Machine protocol capability. Never fall back to a different Agent.
- History consists of ordinary Sessions with sparse `SessionMeta.scheduleId`;
  the Session info bar links back. Provider-native cron history is independent.
- Use shared time calculation for future slots. Cron preview uses its authored
  IANA zone; once/interval inputs use the explicitly labelled device zone. Runtime
  projections must match Machine, activation and definition fingerprint.
