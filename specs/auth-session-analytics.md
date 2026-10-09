# Authenticated activity and session operation analytics

Status: draft
Translation: current

[中文](auth-session-analytics.zh.md)

## Scenario and ownership

In a telemetry-enabled host, entering an authenticated workspace should record one
canonical activity event. Session controls should record useful outcomes without
also counting every request as a separate usage action. The
[platform contract](../packages/platform/AGENTS.md) still hard-disables all local
OSS telemetry; this specification does not enable any client or transport.

## Event contract

- Auth readiness emits `app/active`, retaining `active_context: authenticated_app`,
  identity, workspace, OS, `auth_route_ready_ms`, and launch performance properties.
  Remove `app/auth_ready`; its funnel step migrates to `app/active` filtered by
  `active_context: authenticated_app`. CLI `app/active` remains unchanged.
- Remove `session/stop_requested`; retain `stop_blocked`,
  `stop_request_succeeded`, and `stop_request_failed` under `session/`.
  Success means the request helper resolved, normally after writing the cancel
  pointer. A deleted session can return without writing. It does not acknowledge
  RPC delivery or a stopped turn. Both settled outcomes carry `duration_ms` for
  the helper, not time to stop the agent.
- Remove `session/queue_item_reorder_requested`; retain `queue_item_reordered`
  and `queue_item_reorder_failed` under `session/`, with helper `duration_ms`.
  The existing success event includes harmless no-ops (same or missing item),
  and does not prove the order changed or remote synchronization completed.
- Remove `session/search_open_requested` from the detail menu. Keep the
  conversation's guarded `session/search_opened` event and existing close/result
  events. It records the handler opening local search, not a render acknowledgment;
  its existing `source: conversation` does not distinguish menu from shortcut.

Settled success + failure counts can describe completed helper attempts, but no
longer provide an independent request denominator or detect requests interrupted
by process exit. Blocked actions remain separate. Historical 100% success is not
proof that an operation cannot fail. No actual turn-stop outcome is introduced.

## Evidence and limits

Public owners: `packages/components/src/routes/$workspaceName/_auth.tsx`,
`components/sessions/session-chat-interface.tsx`, `session-detail.tsx`, and
`hooks/use-session-actions.ts` / `use-session-doc.ts` under the same source root.
CLI activity lives in `apps/cli/src/commands/analytics-events.ts`.
No raw production events or dashboard configuration were available for validation;
existing consumers of retired event names need migration when the host adopts this.
