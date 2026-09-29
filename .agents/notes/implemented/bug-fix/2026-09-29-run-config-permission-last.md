# Apply permission last and check it before the prompt

Status: implemented
Translation: current
Language: [中文](2026-09-29-run-config-permission-last.zh.md)

## Abstract

Lody set a turn's permission mode before switching its model, then recorded the
requested mode as the result. Claude rebuilds its permission modes on a model switch
and falls back to `default` when the new model lacks the current one. So a requested
`plan` could become `default` (wider) without anyone seeing it. The applier now sets
the model first, ordinary options next, and Plan and the permission mode last. Before
the prompt it checks them against what the agent itself reported for that setting. A
restrictive request that cannot be confirmed, or any result wider than the request,
stops the turn with the requested and actual values. This is the first step of the
per-model ACP controls work; it ships before any validation is relaxed.

## Problem

- **Ordering**: `applyAcpSessionRunConfig` called `setSessionMode` before
  `unstable_setSessionModel`, so a model switch could rebuild or downgrade the mode
  that had just been set.
- **Requested value as the result**: a successful mode call wrote the requested
  mode into the runtime snapshot even when the agent reported a different one.
- **Suppressed warnings**: rejected Plan requests for Claude and Codex were kept
  out of visible warnings.
- **No provenance**: `AgentClient` did not record whether a setting's result came
  from the agent. `setSessionMode` returned nothing, and asynchronous
  `config_option_update` notifications replaced the option list with no way to tell
  them apart from a setting's own response.

## Decision

- **Order**: model, then ordinary options, then Plan (Core `plan_mode` or legacy
  `collaboration_mode`), then `_permission` options, then the permission mode.
- **Intent**: `resolveSessionSafetyIntent` walks history directory rows up to the
  executing turn and returns the latest mode and Plan separately. The daemon reads
  directory rows, not turn bodies. An inherited setting is sent again when the turn
  switched model or the agent does not already report it.
- **Evidence**:
  - `setSessionMode` returns `config-response` (the list the agent returned for
    this request), `set-mode-ack` (a `session/set_mode` actually sent and answered),
    or `none` (an empty acknowledgement, or nothing sent).
  - `AgentClient` bumps a report generation on every agent-reported list and every
    `current_mode_update`. A report after a setting may contradict it but never
    confirms it.
- **Decision**: built-in modes are ranked in `acp-permission-order.ts`; Claude
  `plan` and Codex `read-only` are restrictive. The checks follow the
  [safety Spec](../../../../specs/acp-run-config-safety.md):
  - a restrictive request that is unconfirmed, failed, not comparable, or
    contradicted stops the turn;
  - a confirmed wider result stops any turn;
  - any other mismatch becomes a visible warning.

  A stopped turn surfaces as `turn_pre_prompt_failed` with a message naming the
  requested and actual values, so older clients need no new error code.
- **Runtime snapshot**: a `set-mode-ack` fills the mode only when the agent reports
  no mode state; it never overwrites a reported one.

## Alternatives

- **Use the UI face classification as the order**: `classifyPermissionModeFace`
  only chooses an icon; `default` and unknown modes both map to `hidden`.
- **Keep the order and only stop reporting the requested mode**: the widening would
  become visible, but it would still happen.
- **A one-time "accept wider permission" flow** (PR #333): deferred. Stopping with a
  clear message is enough for now, and the Spec lists it as an open question.

## Verification

- `acp-session-config-applier.test.ts` drives a stateful fake agent. It rebuilds
  modes on a model switch, answers with a full list, a bare ack or an empty ack, and
  can report on its own. Four rules were ablated and each ablation failed its test:
  - treating an empty ack as confirmation;
  - ignoring later reports;
  - never re-sending an inherited mode;
  - letting a wider non-restrictive result pass.

  The last one first passed silently, so a dedicated test was added.
- Shared tests cover per-field intent resolution and the mode order.
- `tests/session-execution-service.test.ts` now stalls at the model step, which is
  the first setting, and still proves a stop sends nothing after it.
- Not verified: real Claude and Codex adapters end to end; the per-model proposal
  lists the e2e flows.
